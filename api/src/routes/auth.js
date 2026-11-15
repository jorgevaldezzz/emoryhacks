import { Router } from "express";
import { login, signup, signToken } from "../auth.js";
import { requireAuth } from "../middleware.js";

const router = Router();

router.post("/signup", async (req, res, next) => {
  try {
    const user = await signup({
      email: req.body?.email,
      password: req.body?.password,
      name: req.body?.name,
      username: req.body?.username,
    });
    const token = signToken(user);
    res.status(201).json({ token, user });
  } catch (err) {
    next(err);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const user = await login({
      email: req.body?.email,
      password: req.body?.password,
    });
    const token = signToken(user);
    res.json({ token, user });
  } catch (err) {
    next(err);
  }
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
