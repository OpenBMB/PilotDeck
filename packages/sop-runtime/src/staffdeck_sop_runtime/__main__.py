"""Run the portable SOP runtime as a container entrypoint."""

import uvicorn


if __name__ == "__main__":
    uvicorn.run("staffdeck_sop_runtime.api:app", host="0.0.0.0", port=8091)
