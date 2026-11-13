import tempfile
import unittest
from pathlib import Path

from local_helper.server import (
    ACCURATE_MODEL,
    build_accurate_command,
    build_initial_prompt,
    correct_hashtag_homophones,
    correct_unambiguous_chinese_phrases,
    validate_job_options,
    validate_youtube_url,
    validate_video_url,
)


class ValidateYouTubeUrlTests(unittest.TestCase):
    def test_accepts_watch_and_short_urls(self):
        self.assertEqual(
            validate_youtube_url("https://www.youtube.com/watch?v=KjxK61mBK54"),
            "https://www.youtube.com/watch?v=KjxK61mBK54",
        )
        self.assertEqual(
            validate_youtube_url("https://youtu.be/KjxK61mBK54"),
            "https://youtu.be/KjxK61mBK54",
        )

    def test_rejects_non_youtube_and_non_video_urls(self):
        with self.assertRaises(ValueError):
            validate_youtube_url("https://example.com/watch?v=abc")
        with self.assertRaises(ValueError):
            validate_youtube_url("https://www.youtube.com/")
        with self.assertRaises(ValueError):
            validate_youtube_url("https://www.youtube.com/watch?list=playlist")
        with self.assertRaises(ValueError):
            validate_youtube_url("http://www.youtube.com/watch?v=abc")


class ValidateVideoUrlTests(unittest.TestCase):
    def test_accepts_xiaohongshu_note_and_preserves_signature(self):
        for path in ("explore", "discovery/item"):
            url = f"https://www.xiaohongshu.com/{path}/67abc123?xsec_token=signed"
            self.assertEqual(validate_video_url(url), url)

    def test_rejects_unsafe_or_non_note_addresses(self):
        for url in (
            "http://www.xiaohongshu.com/explore/abc",
            "https://www.xiaohongshu.com.evil.com/explore/abc",
            "https://www.xiaohongshu.com/",
            "https://www.xiaohongshu.com/user/profile/abc",
            "https://user:password@www.xiaohongshu.com/explore/abc",
            "https://www.xiaohongshu.com:43127/explore/abc",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_video_url(url)

    def test_still_accepts_youtube(self):
        url = "https://www.youtube.com/watch?v=KjxK61mBK54"
        self.assertEqual(validate_video_url(url), url)


class AccurateTranscriptionTests(unittest.TestCase):
    def test_corrects_only_unambiguous_full_chinese_phrases(self):
        self.assertEqual(
            correct_unambiguous_chinese_phrases(
                "中年积雪的祁连山，风沙漫天的戈壁大墓，像深蓝色的鼠锦。"
            ),
            "终年积雪的祁连山，风沙漫天的戈壁大漠，像深蓝色的蜀锦。",
        )
        self.assertEqual(correct_unambiguous_chinese_phrases("一座戈壁大墓"), "一座戈壁大墓")

    def test_corrects_only_homophones_named_by_public_hashtags(self):
        pronunciations = {
            "封": "feng", "风": "feng", "狼": "lang", "居": "ju", "胥": "xu", "须": "xu",
            "戈": "ge", "壁": "bi", "大": "da", "墓": "mu",
        }
        pinyinizer = lambda value: tuple(pronunciations.get(character, character) for character in value)

        self.assertEqual(
            correct_hashtag_homophones(
                "二十一岁风狼居须，右边是戈壁大墓。",
                "#封狼居胥 #霍去病",
                pinyinizer,
            ),
            "二十一岁封狼居胥，右边是戈壁大墓。",
        )

    def test_builds_prompt_from_title_and_public_description(self):
        prompt = build_initial_prompt(
            "霍去病：少年将军",
            "19岁打通河西走廊，21岁封狼居胥。\n#霍去病 #汉武帝",
        )

        self.assertEqual(
            prompt,
            "霍去病：少年将军\n#霍去病 #汉武帝\n"
            "19岁打通河西走廊，21岁封狼居胥。 #霍去病 #汉武帝",
        )

    def test_accepts_only_known_modes_and_languages(self):
        self.assertEqual(
            validate_job_options("accurate", "zh", "  霍去病\n睡前故事  "),
            ("accurate", "zh", "霍去病 睡前故事"),
        )
        self.assertEqual(validate_job_options("fast", "auto", ""), ("fast", "auto", ""))

        with self.assertRaises(ValueError):
            validate_job_options("remote", "zh", "")
        with self.assertRaises(ValueError):
            validate_job_options("accurate", "../../etc/passwd", "")

    def test_builds_fixed_local_mlx_command(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            command = build_accurate_command(
                Path("/safe/mlx_whisper"),
                directory / "audio.wav",
                directory,
                "zh",
                "霍去病：少年将军",
            )

        self.assertEqual(command[0], "/safe/mlx_whisper")
        self.assertIn(ACCURATE_MODEL, command)
        self.assertEqual(command[command.index("--language") + 1], "zh")
        self.assertEqual(command[command.index("--condition-on-previous-text") + 1], "False")
        self.assertEqual(command[command.index("--initial-prompt") + 1], "霍去病：少年将军")
        self.assertNotIn("shell=True", command)


if __name__ == "__main__":
    unittest.main()
