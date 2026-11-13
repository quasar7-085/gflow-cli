"""Run the Flow i2v editor in an existing Ego Lite task space."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from rich.console import Console

from gflow_cli import json_output
from gflow_cli.api.transports.migrated_composer import VIDEO_MODEL_MENU_MATCHERS
from gflow_cli.api.video import (
    Aspect,
    GenerateVideoRequest,
    Mode,
    VideoModel,
    VideoResult,
    VideoStatus,
)
from gflow_cli.config import get_settings
from gflow_cli.errors import ConfigurationError, FlowApiError
from gflow_cli.paths import validate_job_id
from gflow_cli.profile_lease import ProfileLease

_SCRIPT = Path(__file__).with_name("ego_i2v.mjs")
_RETRY_HINT = "Inspect the same Flow project for a submitted job before trying again."


async def generate(
    request: GenerateVideoRequest,
    *,
    space: str,
    project: str | None,
    title: str,
    output: Path | None,
    out_dir: Path | None,
) -> VideoResult:
    if request.count != 1 or request.start_image is None or request.end_image_ref_id:
        raise ConfigurationError(detail="Ego Lite i2v supports one clip using local frame files.")
    for frame in (request.start_image, request.end_image):
        if frame is not None and not frame.is_file():
            raise ConfigurationError(detail=f"Frame must be a regular local file: {frame}")
    if request.model is None or request.model not in VIDEO_MODEL_MENU_MATCHERS:
        raise ConfigurationError(detail="Select an available Flow video model.")
    if not request.prompt.strip():
        raise ConfigurationError(detail="Enter a non-empty Flow prompt.")
    if project and not all(c.isascii() and (c.isalnum() or c == "-") for c in project):
        raise ConfigurationError(detail="Invalid Flow project ID.")
    if get_settings().storage_uri:
        raise ConfigurationError(detail="Ego Lite i2v saves to local storage.")
    directory = output.parent if output else out_dir or get_settings().output_dir
    directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    if output and output.suffix.lower() != ".mp4":
        raise ConfigurationError(detail="Ego Lite i2v requires an .mp4 output path.")
    if output and os.path.lexists(output):
        raise ConfigurationError(detail=f"Output already exists: {output}")

    model = VIDEO_MODEL_MENU_MATCHERS[request.model]
    # Keep prompt and local paths out of process arguments and download beside the destination.
    with TemporaryDirectory(prefix=".gflow-ego-", dir=directory) as staging:
        temporary = Path(staging)
        start = temporary / f"start-{temporary.name[-8:]}{request.start_image.suffix}"
        shutil.copyfile(request.start_image, start)
        end = None
        if request.end_image:
            end = temporary / f"end-{temporary.name[-8:]}{request.end_image.suffix}"
            shutil.copyfile(request.end_image, end)
        payload: dict[str, Any] = {
            "space": int(space),
            "page": os.environ.get("GFLOW_EGO_PAGE", "p1"),
            "project": project,
            "title": title,
            "model": model.contains,
            "exclude": model.excludes,
            "aspect": "16:9" if request.aspect is Aspect.LANDSCAPE else "9:16",
            "duration": request.duration,
            "resolution": request.resolution,
            "start": str(start),
            "end": str(end) if end else None,
            "prompt": request.prompt,
            "output": str(temporary / "video.mp4"),
        }
        input_file = temporary / "request.json"
        input_file.write_text(json.dumps(payload), encoding="utf-8")
        script = "const inputPath = " + json.dumps(str(input_file)) + ";\n"
        script += _SCRIPT.read_text(encoding="utf-8")
        try:
            process = await asyncio.create_subprocess_exec(
                "ego-browser", "nodejs", "-e", script, stdout=asyncio.subprocess.PIPE
            )
        except FileNotFoundError as exc:
            raise ConfigurationError(detail="ego-browser must be available on PATH.") from exc
        try:
            stdout, _ = await process.communicate()
        except asyncio.CancelledError:
            if process.returncode is None:
                process.terminate()
                await process.wait()
            raise
        if process.returncode:
            raise FlowApiError(
                detail="The Ego Lite video command did not complete.",
                remediation_hint=_RETRY_HINT,
            )
        try:
            result = json.loads(stdout.decode().strip().splitlines()[-1])
            media_id = validate_job_id(result["media_id"])
            project_id = validate_job_id(result["project"])
            video = temporary / "video.mp4"
            with video.open("rb") as handle:
                valid = handle.read(12)[4:8] == b"ftyp" and video.stat().st_size > 1024
            if not valid:
                raise ValueError("download did not contain an MP4")
            destination = output or directory / f"{media_id}.mp4"
            os.link(video, destination)
        except (OSError, ValueError, KeyError, IndexError, TypeError) as exc:
            raise FlowApiError(
                detail="Flow returned a result but it could not be saved as a new MP4.",
                remediation_hint=_RETRY_HINT,
            ) from exc
    return VideoResult(
        status=VideoStatus(media_id, "MEDIA_GENERATION_STATUS_SUCCESSFUL"),
        local_path=destination.resolve(),
        project_id=project_id,
    )


async def run_cli(
    *,
    space: str,
    start: str | None,
    end: str | None,
    uses_media_id: bool,
    prompt: str,
    aspect: str,
    model: VideoModel,
    duration: int | None,
    resolution: str | None,
    count: int,
    profile: str | None,
    tool_specs: tuple[str, ...],
    project: str | None,
    title: str,
    output: Path | None,
    out_dir: Path | None,
    as_json: bool,
) -> None:
    if not (space.isascii() and space.isdecimal() and len(space) <= 16 and 0 < int(space) < 2**53):
        raise ConfigurationError(detail="GFLOW_EGO_SPACE must be a positive Ego Lite space ID.")
    if uses_media_id or not start or count != 1 or profile or tool_specs:
        raise ConfigurationError(
            detail="Ego Lite i2v supports one clip from local files, with the active Ego session.",
            remediation_hint="Omit --profile and --tool and use local files for the frame inputs.",
        )
    request = GenerateVideoRequest(
        prompt=prompt,
        mode=Mode.I2V,
        aspect=Aspect.from_cli(aspect),
        model=model,
        duration=duration,
        resolution=resolution,
        count=count,
        start_image=Path(start),
        end_image=Path(end) if end else None,
    )
    async with ProfileLease(get_settings().home / f"ego-space-{int(space)}"):
        result = await generate(
            request, space=space, project=project, title=title, output=output, out_dir=out_dir
        )
    if as_json:
        json_output.emit(
            json_output.video_result(command="video i2v", request=request, result=result)
        )
    else:
        Console().print("Saved:", str(result.local_path), markup=False)
