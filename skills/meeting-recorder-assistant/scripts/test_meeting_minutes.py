import unittest

from meeting_minutes import extract_next_meeting


class ExtractNextMeetingTests(unittest.TestCase):
    def test_current_meeting_date_is_not_next_meeting(self):
        self.assertIsNone(extract_next_meeting("Meeting date: 2024-01-01\nAgenda: weekly review."))

    def test_unlabeled_date_is_not_next_meeting(self):
        self.assertIsNone(extract_next_meeting("The report is due 2024-01-01."))

    def test_explicit_next_meeting_date_is_preserved(self):
        self.assertEqual(extract_next_meeting("Next meeting: 2024-01-02"), "2024-01-02")

    def test_chinese_next_meeting_date_is_preserved(self):
        self.assertEqual(extract_next_meeting("下次会议：2024-01-02"), "2024-01-02")


if __name__ == "__main__":
    unittest.main()
