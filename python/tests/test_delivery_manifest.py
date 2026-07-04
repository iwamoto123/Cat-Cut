import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from build_delivery_manifest import build_manifest  # noqa: E402


class BuildDeliveryManifestTest(unittest.TestCase):
    def test_build_manifest_from_minimal_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            (run_dir / "step08_composition").mkdir(parents=True)
            (run_dir / "output").mkdir(parents=True)

            composition = {
                "timeline": {
                    "total_duration_ms": 120000,
                    "cuts": [
                        {
                            "telop": {
                                "pages": [
                                    {"lines": ["社長の想いを", "届ける"]},
                                    {"lines": ["採用につなげる"]},
                                ]
                            }
                        }
                    ],
                },
                "meta": {
                    "source_video": "/tmp/source.mp4",
                    "edited_duration_ms": 120000,
                    "orientation": "horizontal",
                },
            }
            (run_dir / "step08_composition" / "composition.json").write_text(
                json.dumps(composition, ensure_ascii=False),
                encoding="utf-8",
            )
            final_video = run_dir / "output" / "final.mp4"
            final_video.write_bytes(b"fake")
            (run_dir / "output" / "render_output.json").write_text(
                json.dumps({"finalVideo": str(final_video)}),
                encoding="utf-8",
            )

            manifest = build_manifest(run_dir, title="テスト回", customer_id="customer-001")

            self.assertEqual(manifest["customer_id"], "customer-001")
            self.assertEqual(manifest["main_episode"]["title"], "テスト回")
            self.assertEqual(manifest["main_episode"]["duration_ms"], 120000)
            self.assertTrue(manifest["main_episode"]["video_path"].endswith("final.mp4"))
            self.assertEqual(len(manifest["posts"]), 2)
            self.assertEqual(manifest["posts"][0]["platform"], "youtube")


if __name__ == "__main__":
    unittest.main()
