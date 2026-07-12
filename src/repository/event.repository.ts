import { Firestore } from "firebase-admin/firestore";
import { db, firebase } from "../config/firebase.js";
import { COLLECTIONS } from "../constants/collection.js";
import { IEvent } from "../types/routes/event.js";

class EventRepository {
  private db: Firestore;
  private collection: `${COLLECTIONS}`;

  constructor() {
    this.db = db;
    this.collection = COLLECTIONS.EVENTS;
  }

  // Firestore auto-ID — an append-only telemetry stream, never read by doc id.
  add = async (event: IEvent): Promise<void> => {
    await this.db.collection(this.collection).add({
      ...event,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  };
}

export default EventRepository;
