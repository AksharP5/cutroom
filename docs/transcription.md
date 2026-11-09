# Local transcription

Cutroom uses a locally installed `whisper-cli` and a complete Whisper model. It does not install a runtime or download a model while transcribing.

The runtime is discovered from `HYPERFRAMES_WHISPER_PATH`, `PATH`, or the existing HyperFrames Whisper cache. Models are discovered in the HyperFrames cache selected by `HYPERFRAMES_CACHE_DIR`. Incomplete downloads are ignored.

Select a video or audio element in the Script panel and choose **Transcribe locally**. Select another clip to create another transcript. A multilingual recording requires an installed multilingual model.

You can also import normalized JSON word timings:

```json
[
  { "id": "word-1", "text": "Make", "start": 0.1, "end": 0.4 },
  { "id": "word-2", "text": "room", "start": 0.5, "end": 0.9 }
]
```

Times are seconds in the original media. IDs must be unique, words must be ordered, and each end must follow its start. The imported transcript must match the selected source element. A clip's existing transcript is retained to preserve its cut history.
