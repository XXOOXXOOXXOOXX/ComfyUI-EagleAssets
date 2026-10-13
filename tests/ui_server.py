import json
import sys
import tempfile
from fixture import Fixture

with tempfile.TemporaryDirectory(prefix="eagle-assets-test-") as root:
    fixture = Fixture(root, media=True)
    print(json.dumps({"host": fixture.host}), flush=True)
    try:
        sys.stdin.readline()
    finally:
        fixture.close()
