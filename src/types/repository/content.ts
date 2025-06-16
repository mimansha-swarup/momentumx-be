export interface IGetTopicByUserIdArgs {
  userId: string;
  limit: number;
  cursor: {
    createdAt: string;
    docId: string;
  };
  filters: Record<string, unknown>;

}
