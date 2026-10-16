"""Pure result checks shared by Core transitions and host preflight adapters."""

from typing import Any


def slot_is_filled(value: Any) -> bool:
    return (
        bool(value.strip())
        if isinstance(value, str)
        else value not in (None, "", [], {})
    )


class SopResultValidator:
    @staticmethod
    def missing_slots(fields, slots):
        return [
            str(field)
            for field in fields
            if str(field).strip() and not slot_is_filled(slots.get(str(field)))
        ]

    @staticmethod
    def missing_capabilities(required, receipts):
        succeeded = {
            receipt.capability_id
            for receipt in receipts
            if receipt.status == "succeeded"
        }
        return sorted(set(required) - succeeded)
