import { Firestore } from "firebase-admin/firestore";
import { db } from "../config/firebase.js";
import { COLLECTIONS } from "../constants/collection.js";
import { extractTextFromHTML } from "../utlils/regex.js";

class UserRepository {
  private db: Firestore;
  private collection: `${COLLECTIONS}`;

  constructor() {
    this.db = db;
    this.collection = COLLECTIONS.USERS;
  }

  add = async (userId: string, data: unknown) => {
    try {
      if (!userId) {
        throw new Error("userId is required");
      }
      await this.db
        .collection(this.collection)
        .doc(userId)
        .set(data as Record<string, unknown>, { merge: true });
    } catch (error) {
      console.log("error in add", error);
    }
  };
  update = async (userId: string, data: unknown) => {
    try {
      if (!userId) {
        throw new Error("userId is required");
      }
      await this.db
        .collection(this.collection)
        .doc(userId)
        .update(data as Record<string, unknown>);
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
    let html = "";
    try {
      const res = await fetch(url);
      if (res) {
        html = await res?.text();

        return extractTextFromHTML(html);
      }
    } catch (error) {
      console.log("error:  at getWebsiteContent", error);
    }
    return html;
  };
}

export default UserRepository;
