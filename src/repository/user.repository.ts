import { Firestore } from "firebase-admin/firestore";
import { db } from "../config/firebase";
import { COLLECTIONS } from "../constants/collection";
import { extractTextFromHTML } from "../utlils/regex";

class UserRepository {
  private db: Firestore;
  private collection: `${COLLECTIONS}`;

  constructor() {
    this.db = db;
    this.collection = COLLECTIONS.USERS;
  }

  update = async (userId: string, data: unknown) => {
    try {

      if (!userId) {
        throw new Error("userId is required");
      }
      await this.db
        .collection(this.collection)
        .doc(userId)
        .update(data as Record<string, unknown>);

      console.log();
    } catch (error) {
      console.log("error", error);
    }
  };

  get = async (userId: string) => {
    try {
      const doc = await this.db.collection(this.collection).doc(userId).get();
      return doc.data();
    } catch (error) {
      console.log("error", error);
    }
  };

  getWebsiteContent = async (url: string) => {
    try {
      const res = await fetch(url);
      const html = await res.text();

      return extractTextFromHTML(html);
    } catch (error) {
      console.log("error: ", error);
    }
  };
}

export default UserRepository;
