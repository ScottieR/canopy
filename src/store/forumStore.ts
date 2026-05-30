import { create } from 'zustand';

export interface ForumState {
  id: string;
  active: boolean;
  messages: any[];
  // NEW FIELDS FOR POINT 4
  totalTokens: number;
  totalCost: number;
}

export const useForumStore = create<any>((set) => ({
  forums: [],
  // Example update function to increment tokens/cost
  incrementTokensAndCost: (forumId: string, tokens: number, cost: number) => 
    set((state: any) => ({
      forums: state.forums.map((f: ForumState) => 
        f.id === forumId 
          ? { ...f, totalTokens: (f.totalTokens || 0) + tokens, totalCost: (f.totalCost || 0) + cost }
          : f
      )
    })),
}));
