/**
 * Mongoose models for accounts + per-user gallery images.
 * Identity for gallery queries always comes from the auth token (req.userId),
 * never from a client-supplied userId.
 */

import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  },
  { timestamps: true }
);

const imageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    url: String,
    storageKey: String,
    filename: String,
    originalName: String,
    note: String,
    /** upload | chert — kept for the website + pose-agent */
    source: { type: String, default: "upload" },
    kind: { type: String, enum: ["reference", "result"], default: "reference" },
    /** Short code a user can text to Chert to attach this image */
    chertCode: { type: String, index: true },
  },
  { timestamps: true }
);

imageSchema.index({ userId: 1, createdAt: -1 });

export const User = mongoose.models.User || mongoose.model("User", userSchema);
export const Image = mongoose.models.Image || mongoose.model("Image", imageSchema);
