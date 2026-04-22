// Copyright 2025 the AAI authors. MIT license.
/** LLM provider type — we re-export Vercel AI SDK's LanguageModel; no wrapping. */

import type { LanguageModel } from "ai";

export type LlmProvider = LanguageModel;
