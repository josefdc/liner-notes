/**
 * The named schemas of the contract: each one has a JSON Schema snapshot in `snapshots/`.
 */

import {
  AnalyzeRequest,
  AnalyzeResponse,
  ApiError,
  FactoidsRequest,
  FactoidsResponse,
  HealthResponse,
  ReadyResponse,
  ReplayRecord,
  ReplaysResponse,
  ResumeRequest,
  RunResponse,
  RunTokenRequest,
  RunTokenResponse,
  SearchSuggestResponse,
} from "./api.js";
import { AudioFeatures } from "./audio.js";
import { AnalyzeStreamEvent, FactoidStreamEvent } from "./events.js";
import { Claim, Evidence, Measured } from "./evidence.js";
import { LLM_SCHEMAS } from "./llm.js";
import { TrackAnalysis } from "./track.js";

export const CONTRACT_SCHEMAS = {
  TrackAnalysis,
  AudioFeatures,
  Evidence,
  Claim,
  Measured,
  AnalyzeStreamEvent,
  FactoidStreamEvent,
  ApiError,
  AnalyzeRequest,
  AnalyzeResponse,
  ResumeRequest,
  SearchSuggestResponse,
  FactoidsRequest,
  FactoidsResponse,
  RunResponse,
  ReplaysResponse,
  RunTokenRequest,
  RunTokenResponse,
  HealthResponse,
  ReadyResponse,
  ReplayRecord,
  ...LLM_SCHEMAS,
} as const;

export type ContractSchemaName = keyof typeof CONTRACT_SCHEMAS;
