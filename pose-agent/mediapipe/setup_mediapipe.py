"""Install the pinned MediaPipe runtime and download Google's Pose Landmarker model."""
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODEL = HERE / "models" / "pose_landmarker_full.task"
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task"


def main():
    venv = HERE / ".venv"
    python = venv / "bin" / "python"
    if os.name == "nt":
        python = venv / "Scripts" / "python.exe"
    if not python.exists():
        subprocess.check_call([sys.executable, "-m", "venv", str(venv)])
    subprocess.check_call([str(python), "-m", "pip", "install", "-r", str(HERE / "requirements.txt")])
    if not MODEL.exists():
        MODEL.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(MODEL_URL, MODEL)
    print(f"MediaPipe ready: {MODEL}")


if __name__ == "__main__":
    main()
