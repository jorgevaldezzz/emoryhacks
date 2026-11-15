import "dotenv/config";
import { MongoClient } from "mongodb";

const configuredQuota = Number(process.env.GALLERY_QUOTA_BYTES || 100 * 1024 * 1024);
if (!Number.isSafeInteger(configuredQuota) || configuredQuota <= 0) {
  throw new Error("GALLERY_QUOTA_BYTES must be a positive integer");
}
export const GALLERY_QUOTA_BYTES = configuredQuota;

let client;
let db;

function collection(name) {
  if (!db) throw new Error("Database has not been opened yet");
  return db.collection(name);
}

export async function openDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGODB_URI to connect to MongoDB Atlas");
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(process.env.MONGODB_DATABASE || "imphotogenic");
  await Promise.all([
    db.collection("users").createIndex(
      { emailKey: 1 },
      { unique: true, name: "uniq_users_email_key" }
    ),
    db.collection("gallery").createIndex(
      { userId: 1, createdAt: -1 },
      { name: "gallery_user_createdAt" }
    ),
  ]);
  return db;
}

export async function closeDb() {
  if (client) await client.close();
  client = null;
  db = null;
}

export async function findUserByEmail(email) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await collection("users").findOne({ emailKey: normalizedEmail });
  return user ? { ...user, id: user._id } : null;
}

export async function findUserById(id) {
  const user = await collection("users").findOne({ _id: id });
  return user ? { ...user, id: user._id } : null;
}

export async function insertUser(user) {
  await collection("users").insertOne({
    _id: user.id,
    email: user.email.trim().toLowerCase(),
    emailKey: user.email.trim().toLowerCase(),
    name: user.name,
    passwordHash: user.passwordHash,
    createdAt: user.createdAt,
    galleryBytes: 0,
    galleryQuotaBytes: GALLERY_QUOTA_BYTES,
  });
}

export async function listGalleryForUser(userId) {
  return collection("gallery")
    .find({ userId }, { projection: { image: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
}

export async function findGalleryItemForUser(id, userId) {
  return collection("gallery").findOne({ _id: id, ...(userId ? { userId } : {}) });
}

export async function insertGalleryItem(item) {
  const session = client.startSession();
  let reserved = false;
  try {
    await session.withTransaction(async () => {
      const result = await collection("users").updateOne(
        {
          _id: item.userId,
          $expr: {
            $lte: [{ $add: ["$galleryBytes", item.byteSize] }, "$galleryQuotaBytes"],
          },
        },
        { $inc: { galleryBytes: item.byteSize } },
        { session }
      );
      if (!result.matchedCount) return;
      await collection("gallery").insertOne(item, { session });
      reserved = true;
    });
    return reserved;
  } finally {
    await session.endSession();
  }
}

export async function deleteGalleryItem(id, userId) {
  const session = client.startSession();
  let deleted = null;
  try {
    await session.withTransaction(async () => {
      deleted = null;
      deleted = await collection("gallery").findOneAndDelete(
        { _id: id, userId },
        { projection: { _id: 1, byteSize: 1 }, session }
      );
      if (deleted) {
        await collection("users").updateOne(
          { _id: userId },
          { $inc: { galleryBytes: -deleted.byteSize } },
          { session }
        );
      }
    });
    return deleted;
  } finally {
    await session.endSession();
  }
}
