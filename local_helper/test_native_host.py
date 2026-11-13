import io
import json
import struct
import unittest
from unittest import mock

from local_helper import native_host


class NativeMessageProtocolTests(unittest.TestCase):
    def test_reads_and_writes_length_prefixed_json(self):
        payload = {"action": "start", "value": "中文"}
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        input_stream = io.BytesIO(struct.pack("=I", len(encoded)) + encoded)

        self.assertEqual(native_host.read_message(input_stream), payload)

        output_stream = io.BytesIO()
        native_host.write_message(output_stream, {"ok": True})
        output_stream.seek(0)
        size = struct.unpack("=I", output_stream.read(4))[0]
        self.assertEqual(json.loads(output_stream.read(size)), {"ok": True})


class EnsureServerTests(unittest.TestCase):
    def test_does_not_start_a_second_server(self):
        starter = mock.Mock()

        result = native_host.ensure_server(
            health_check=lambda: True,
            kickstart=starter,
            spawn=starter,
            sleep=lambda _: None,
        )

        self.assertEqual(result, {"ok": True, "status": "already_running"})
        starter.assert_not_called()

    def test_kickstarts_launch_agent_and_waits_for_health(self):
        health = iter([False, False, True])
        spawn = mock.Mock()

        result = native_host.ensure_server(
            health_check=lambda: next(health),
            kickstart=lambda: True,
            spawn=spawn,
            sleep=lambda _: None,
            attempts=3,
        )

        self.assertEqual(result, {"ok": True, "status": "started"})
        spawn.assert_not_called()

    def test_falls_back_to_detached_process_without_launch_agent(self):
        health = iter([False, False, True])
        spawn = mock.Mock()

        result = native_host.ensure_server(
            health_check=lambda: next(health),
            kickstart=lambda: False,
            spawn=spawn,
            sleep=lambda _: None,
            attempts=3,
        )

        self.assertEqual(result, {"ok": True, "status": "started"})
        spawn.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
