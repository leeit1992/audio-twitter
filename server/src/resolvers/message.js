import mongoose from 'mongoose';
import { combineResolvers } from 'graphql-resolvers';
import { withFilter } from 'apollo-server';

import pubsub, { EVENTS } from '../subscription';
import { isAuthenticated, isMessageOwner } from './authorization';
import { processFile } from '../utils/upload';

// to base64, da klijent aplikacija ne bi radila sa datumom nego sa stringom
const toCursorHash = string => Buffer.from(string).toString('base64');

// from base64
const fromCursorHash = string =>
  Buffer.from(string, 'base64').toString('ascii');

export default {
  Query: {
    // kursor je vazan za vrednost podatka, a ne index elementa kao u offset/limmit paginaciji
    // kad se izbrise iz izvadjenih offset postaje nevalidan, a kursor ostaje uvek isti
    // createdAt za cursor
    messages: async (
      parent,
      { cursor, limit = 100, username },
      { models, me },
    ) => {
      const user = username
        ? await models.User.findOne({
            username,
          })
        : null;

      //me je user sa clienta, iz tokena
      const meUser = me ? await models.User.findById(me.id) : null;
      //console.log(me, meUser);

      const ObjectId = mongoose.Types.ObjectId;
      const match = {
        // za prvi upit ne treba cursor
        ...(cursor && {
          newCreatedAt: {
            $lt: new Date(fromCursorHash(cursor)), //MORA NEW DATE()
          },
        }),
        // user page
        ...(username && {
          $or: [
            {
              //njegovi originali
              $and: [
                {
                  userId: ObjectId(user.id),
                },
                { original: true },
              ],
            },
            //ili tudji koje je on rt
            {
              $and: [
                {
                  reposts: {
                    $elemMatch: { reposterId: ObjectId(user.id) },
                  },
                },
                { original: { $ne: true } },
              ],
            },
          ],
        }),
        // timeline, see messages only from following and me
        ...(me &&
          !username && {
            userId: {
              $in: [
                meUser.followingIds.map(id => ObjectId(id)),
                ObjectId(me.id),
              ],
            },
          }),
      };

      //console.log(match);

      const aMessages = await models.Message.aggregate([
        {
          $addFields: {
            newReposts: {
              $concatArrays: [
                [{ createdAt: '$createdAt', original: true }],
                '$reposts',
              ],
            },
          },
        },
        {
          $unwind: '$newReposts', //pomnozi polje
        },
        {
          $addFields: {
            newCreatedAt: '$newReposts.createdAt',
            original: '$newReposts.original',
          },
        },
        { $match: match },
        {
          $sort: {
            newCreatedAt: -1,
          },
        },
        {
          $limit: limit + 1,
        },
      ]);

      const messages = aMessages.map(m => {
        m.id = m._id.toString();
        return m;
      });
      console.log(messages);

      const hasNextPage = messages.length > limit;
      const edges = hasNextPage ? messages.slice(0, -1) : messages; //-1 exclude zadnji

      return {
        edges,
        pageInfo: {
          hasNextPage,
          endCursor: toCursorHash(
            edges[edges.length - 1].newCreatedAt.toString(),
          ),
        },
      };
    },
    message: async (parent, { id }, { models }) => {
      return await models.Message.findById(id);
    },
  },

  Mutation: {
    // combine middlewares
    createMessage: combineResolvers(
      // resolver middleware
      isAuthenticated,
      // obican resolver
      async (parent, { file }, { models, me }) => {
        const fileSaved = await processFile(file);

        // mora create a ne constructor za timestamps
        const message = await models.Message.create({
          fileId: fileSaved.id,
          userId: me.id,
        });
        pubsub.publish(EVENTS.MESSAGE.CREATED, {
          messageCreated: { message },
        });

        return message;
      },
    ),

    deleteMessage: combineResolvers(
      isAuthenticated,
      isMessageOwner,
      async (parent, { id }, { models }) => {
        const message = await models.Message.findById(id);

        if (message) {
          await message.remove();
          return true;
        } else {
          return false;
        }
      },
    ),

    likeMessage: combineResolvers(
      isAuthenticated,
      async (parent, { messageId }, { models, me }) => {
        const likedMessage = await models.Message.findOneAndUpdate(
          { _id: messageId },
          { $push: { likesIds: me.id } },
        );
        return !!likedMessage;
      },
    ),
    unlikeMessage: combineResolvers(
      isAuthenticated,
      async (parent, { messageId }, { models, me }) => {
        const unlikedMessage = await models.Message.findOneAndUpdate(
          { _id: messageId },
          { $pull: { likesIds: me.id } },
        );
        return !!unlikedMessage;
      },
    ),
    repostMessage: combineResolvers(
      isAuthenticated,
      async (parent, { messageId }, { models, me }) => {
        const repostedMessage = await models.Message.findOneAndUpdate(
          { _id: messageId },
          { $push: { reposts: { reposterId: me.id } } },
          { new: true },
        );
        pubsub.publish(EVENTS.MESSAGE.CREATED, {
          messageCreated: { message: repostedMessage },
        });
        return !!repostedMessage;
      },
    ),
    unrepostMessage: combineResolvers(
      isAuthenticated,
      async (parent, { messageId }, { models, me }) => {
        const unrepostedMessage = await models.Message.findOneAndUpdate(
          { _id: messageId },
          { $pull: { reposts: { reposterId: me.id } } },
        );
        return !!unrepostedMessage;
      },
    ),
  },

  Message: {
    user: async (message, args, { loaders }) => {
      // loaders iz contexta koji je prosledjen
      return await loaders.user.load(message.userId);
    },
    file: async (message, args, { loaders }) => {
      return await loaders.file.load(message.fileId);
    },
    likesCount: async (message, args, { models }) => {
      const likedMessage = await models.Message.findById(message.id);
      return likedMessage.likesIds?.length || 0;
    },
    isLiked: async (message, args, { models, me }) => {
      if (!me) return false;
      const likedMessage = await models.Message.findById(message.id);
      return likedMessage.likesIds?.includes(me.id) || false;
    },
    repostsCount: async (message, args, { models }) => {
      const rpMessage = await models.Message.findById(message.id);
      return rpMessage.reposts?.length || 0;
    },
    isReposted: async (message, args, { models, me }) => {
      if (!me) return false;
      const rpMessage = await models.Message.findById(message.id);
      const repost = rpMessage.reposts?.find(r =>
        r.reposterId.equals(me.id),
      );
      return !!repost;
    },
  },

  Subscription: {
    messageCreated: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(EVENTS.MESSAGE.CREATED),
        async (payload, args) => {
          return true;
        },
      ),
    },
  },
};
