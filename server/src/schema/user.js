import { gql } from 'apollo-server-express';

export default gql`
  extend type Query {
    friends(
      username: String!
      isFollowing: Boolean
      isFollowers: Boolean
      limit: Int
    ): [User!]
    whoToFollow(limit: Int): [User!]
    user(username: String!): User
    me: User
  }

  extend type Mutation {
    signUp(
      username: String!
      email: String!
      password: String!
    ): Token!

    signIn(login: String!, password: String!): Token!
    updateUser(
      name: String
      bio: String
      avatar: Upload
      cover: Upload
    ): User!
    deleteUser(id: ID!): Boolean!
    followUser(username: String!): Boolean!
    unfollowUser(username: String!): Boolean!
  }

  type Token {
    token: String!
  }

  type User {
    id: ID!
    username: String!
    email: String!
    role: String
    messages: [Message!]
    name: String
    bio: String
    avatar: File
    cover: File
    followers: [User!]
    following: [User!]
    followersCount: Int
    followingCount: Int
    messagesCount: Int
    isFollowHim: Boolean
    isFollowsMe: Boolean
  }
`;
