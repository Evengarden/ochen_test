import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class AssetAuditCommandTest(unittest.TestCase):
    def test_asset_audit_runs_and_reports_success(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "tools" / "qa_assets.py")],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PASSED:", result.stdout)


if __name__ == "__main__":
    unittest.main()
