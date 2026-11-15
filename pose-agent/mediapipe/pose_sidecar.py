"""Persistent JSON-lines adapter around Google's MediaPipe Pose Landmarker task."""
import base64
import json
import os
import sys
from io import BytesIO
from pathlib import Path

import mediapipe as mp
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
MODEL_PATH = Path(os.environ.get("POSE_MODEL_PATH", HERE / "models" / "pose_landmarker_full.task"))
NAMES = (
    "nose", "left_eye_inner", "left_eye", "left_eye_outer", "right_eye_inner",
    "right_eye", "right_eye_outer", "left_ear", "right_ear", "mouth_left",
    "mouth_right", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_pinky", "right_pinky", "left_index",
    "right_index", "left_thumb", "right_thumb", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle", "left_heel",
    "right_heel", "left_foot_index", "right_foot_index",
)


def create_landmarker():
    if not MODEL_PATH.is_file():
        raise FileNotFoundError(f"MediaPipe model not found: {MODEL_PATH}. Run python3 setup_mediapipe.py")
    options = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(MODEL_PATH)),
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
        num_poses=1,
        min_pose_detection_confidence=0.45,
        min_pose_presence_confidence=0.45,
        min_tracking_confidence=0.45,
    )
    return mp.tasks.vision.PoseLandmarker.create_from_options(options)


def detect(landmarker, encoded):
    raw = base64.b64decode(encoded, validate=True)
    image = Image.open(BytesIO(raw)).convert("RGB")
    pixels = np.asarray(image)
    result = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=pixels))
    if not result.pose_landmarks:
        return {"personVisible": False, "landmarks": {}}
    landmarks = {}
    for name, point in zip(NAMES, result.pose_landmarks[0]):
        visibility = float(point.visibility) if point.visibility is not None else 1.0
        presence = float(point.presence) if point.presence is not None else 1.0
        confidence = min(visibility, presence)
        if point.x < 0 or point.x > 1 or point.y < 0 or point.y > 1:
            confidence = 0.0
        landmarks[name] = {
            "x": float(point.x),
            "y": float(point.y),
            "z": float(point.z),
            "confidence": confidence,
        }
    return {"personVisible": True, "landmarks": landmarks}


def main():
    landmarker = create_landmarker()
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            pose = detect(landmarker, request["image"])
            print(json.dumps({"id": request_id, "ok": True, "pose": pose}), flush=True)
        except Exception as error:  # return request errors without killing the worker
            print(json.dumps({"id": request_id, "ok": False, "error": str(error)}), flush=True)
    landmarker.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ready": False, "error": str(error)}), flush=True)
        sys.exit(1)
