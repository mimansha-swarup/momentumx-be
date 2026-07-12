export interface IGetIdeaByUserIdArgs {
  userId: string;
  limit: number;
  cursor: {
    createdAt: string;
    docId: string;
  };
  filters: Record<string, unknown>;

}
