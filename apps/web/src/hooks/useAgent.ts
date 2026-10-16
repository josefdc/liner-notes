/**
 * useAgent Hook - Connect Frontend to Sonic Agent Backend
 *
 * Features:
 * - SSE streaming for real-time status updates
 * - Human-in-the-loop disambiguation handling
 * - Automatic fallback to non-streaming API
 * - TypeScript types aligned with backend schemas
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { TrackData, LogCode, Factoid } from '../types';
import type { AgentLog } from '../types';
import type { AgentState, UseAgentReturn, SearchCandidate } from './agent/types';
import { API_BASE_URL } from './agent/types';
import { analyzeSync, resumeSync, fetchSuggestions } from './agent/apiClient';

// Re-export types for consumers that import from this file
export type { SearchCandidate, UseAgentReturn } from './agent/types';

// =============================================================================
// Hook Implementation
// =============================================================================

export function useAgent(): UseAgentReturn {
  const [state, setState] = useState<AgentState>({
    status: 'idle',
    logs: [],
    trackData: null,
    candidates: null,
    threadId: null,
    error: null,
    isLoading: false,
    isComplete: false,
  });

  const eventSourceRef = useRef<EventSource | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Ref for reading current state in callbacks without adding state to deps
  const stateRef = useRef(state);
  stateRef.current = state;

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      abortControllerRef.current?.abort();
    };
  }, []);

  /**
   * Add a log entry with optional code and node
   */
  const addLog = useCallback((message: string, code?: LogCode, node?: string) => {
    const log: AgentLog = {
      id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      message,
      timestamp: new Date().toISOString(),
      code,
      node,
    };
    setState(prev => ({
      ...prev,
      logs: [...prev.logs, log],
    }));
  }, []);

  /**
   * Reset state
   */
  const reset = useCallback(() => {
    eventSourceRef.current?.close();
    abortControllerRef.current?.abort();
    setState({
      status: 'idle',
      logs: [],
      trackData: null,
      candidates: null,
      threadId: null,
      error: null,
      isLoading: false,
      isComplete: false,
    });
  }, []);

  /**
   * Handle streaming events
   */
  const handleStreamEvent = useCallback((data: {
    type: string;
    message?: string;
    code?: LogCode;
    node?: string;
    threadId?: string;
    candidates?: SearchCandidate[];
    data?: TrackData;
    error?: string;
  }) => {
    switch (data.type) {
      case 'connected':
        setState(prev => ({
          ...prev,
          threadId: data.threadId || null,
        }));
        addLog('Connected to agent', 'SYS-INIT');
        break;

      case 'status':
        // Pass the code from the backend event
        addLog(data.message || 'Processing...', data.code, data.node);
        // Update status based on node
        if (data.node === 'scout') {
          setState(prev => ({ ...prev, status: 'searching' }));
        } else if (data.node === 'engineer') {
          setState(prev => ({ ...prev, status: 'analyzing' }));
        } else if (data.node === 'historian') {
          setState(prev => ({ ...prev, status: 'researching' }));
        } else if (data.node === 'composer') {
          setState(prev => ({ ...prev, status: 'composing' }));
        }
        break;

      case 'candidates':
        setState(prev => ({
          ...prev,
          status: 'disambiguation',
          candidates: data.candidates || null,
          isLoading: false,
        }));
        addLog(`Found ${data.candidates?.length || 0} matching songs`, 'SYS-WARN');
        break;

      case 'interrupt':
        setState(prev => ({
          ...prev,
          status: 'disambiguation',
          threadId: data.threadId || prev.threadId,
          candidates: data.candidates || null,
          isLoading: false,
        }));
        addLog('Awaiting user selection...', 'SYS-WARN');
        break;

      case 'complete':
        eventSourceRef.current?.close();
        setState(prev => ({
          ...prev,
          status: 'complete',
          trackData: data.data || null,
          isLoading: false,
          isComplete: true,
        }));
        addLog('Analysis complete. Ready for deployment.', 'SYS-READY');
        break;

      case 'error':
        eventSourceRef.current?.close();
        setState(prev => ({
          ...prev,
          status: 'error',
          error: data.error || 'Unknown error',
          isLoading: false,
        }));
        addLog(`Error: ${data.error}`, 'SYS-ERROR');
        break;

      case 'done':
        eventSourceRef.current?.close();
        setState(prev => ({
          ...prev,
          isLoading: false,
        }));
        break;
    }
  }, [addLog]);

  /**
   * Fallback to synchronous API if SSE fails
   */
  const fallbackToSync = useCallback(async (query: string) => {
    addLog('⚡ Switching to standard API...');

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const result = await analyzeSync(query, controller.signal);

      if (result.success && result.data) {
        setState(prev => ({
          ...prev,
          status: 'complete',
          trackData: result.data as TrackData,
          isLoading: false,
          isComplete: true,
        }));
        addLog('✅ Analysis complete!');
      } else {
        setState(prev => ({
          ...prev,
          status: 'error',
          error: result.error || 'Analysis failed',
          isLoading: false,
        }));
        addLog(`❌ ${result.error || 'Analysis failed'}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      const message = error instanceof Error ? error.message : 'Request failed';
      setState(prev => ({
        ...prev,
        status: 'error',
        error: message,
        isLoading: false,
      }));
      addLog(`❌ Error: ${message}`);
    }
  }, [addLog]);

  /**
   * Analyze a song with streaming
   */
  const analyze = useCallback(async (query: string) => {
    // Reset previous state
    eventSourceRef.current?.close();
    abortControllerRef.current?.abort();

    setState({
      status: 'connecting',
      logs: [],
      trackData: null,
      candidates: null,
      threadId: null,
      error: null,
      isLoading: true,
    });

    addLog(`🔍 Searching for "${query}"...`);

    try {
      // Try SSE streaming first
      const url = `${API_BASE_URL}/api/analyze/stream?query=${encodeURIComponent(query)}`;
      const eventSource = new EventSource(url);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        setState(prev => ({ ...prev, status: 'searching' }));
      };

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleStreamEvent(data);
        } catch (e) {
          console.error('[useAgent] Failed to parse SSE event:', e);
        }
      };

      eventSource.onerror = (error) => {
        console.error('[useAgent] SSE error:', error);
        eventSource.close();

        // Fall back to non-streaming API
        fallbackToSync(query);
      };

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed';
      setState(prev => ({
        ...prev,
        status: 'error',
        error: message,
        isLoading: false,
      }));
      addLog(`❌ Error: ${message}`);
    }
  }, [addLog, handleStreamEvent, fallbackToSync]);

  /**
   * Select a candidate after disambiguation
   */
  const selectCandidate = useCallback(async (candidateId: string) => {
    const { threadId, candidates } = stateRef.current;

    if (!threadId) {
      // No thread ID means we need to start fresh with the selected track
      addLog(`🎵 Selected track: ${candidateId}`);
      setState(prev => ({
        ...prev,
        status: 'analyzing',
        isLoading: true,
        candidates: null,
      }));

      // Use the track ID directly to search
      const selectedCandidate = candidates?.find(c => c.id === candidateId);
      if (selectedCandidate) {
        await analyze(`${selectedCandidate.title} ${selectedCandidate.artist}`);
      }
      return;
    }

    addLog(`🎵 Resuming with selected track...`);
    setState(prev => ({
      ...prev,
      status: 'analyzing',
      isLoading: true,
      candidates: null,
    }));

    try {
      // Try streaming resume first
      const url = `${API_BASE_URL}/api/analyze/stream/resume?threadId=${encodeURIComponent(threadId)}&selectedTrackId=${encodeURIComponent(candidateId)}`;
      const eventSource = new EventSource(url);
      eventSourceRef.current = eventSource;

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleStreamEvent(data);
        } catch (e) {
          console.error('[useAgent] Failed to parse resume event:', e);
        }
      };

      eventSource.onerror = async () => {
        eventSource.close();

        // Fallback to POST resume
        try {
          const result = await resumeSync(threadId, candidateId);

          if (result.success && result.data) {
            setState(prev => ({
              ...prev,
              status: 'complete',
              trackData: result.data as TrackData,
              isLoading: false,
              isComplete: true,
            }));
            addLog('✅ Analysis complete!');
          } else {
            throw new Error(result.error || 'Resume failed');
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Resume failed';
          setState(prev => ({
            ...prev,
            status: 'error',
            error: message,
            isLoading: false,
          }));
          addLog(`❌ ${message}`);
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Selection failed';
      setState(prev => ({
        ...prev,
        status: 'error',
        error: message,
        isLoading: false,
      }));
      addLog(`❌ ${message}`);
    }
  }, [addLog, handleStreamEvent, analyze]);

  /**
   * Stream factoids one-by-one via SSE for faster perceived speed
   * Each factoid is emitted immediately when generated
   */
  const decryptMoreFactoidsStream = useCallback((
    trackTitle: string,
    trackArtist: string,
    existingIds: string[],
    onFactoid: (factoid: Factoid) => void
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        trackTitle,
        trackArtist: trackArtist || '',
        existingIds: existingIds.join(','),
      });

      const url = `${API_BASE_URL}/api/factoids/decrypt/stream?${params}`;
      const eventSource = new EventSource(url);

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          switch (data.type) {
            case 'factoid':
              // Emit factoid immediately to callback
              onFactoid(data.data as Factoid);
              break;

            case 'done':
              eventSource.close();
              resolve();
              break;

            case 'error':
              console.warn('[useAgent] Factoid stream error:', data.error);
              // Continue - don't fail the whole stream for one error
              break;
          }
        } catch (e) {
          console.error('[useAgent] Failed to parse factoid event:', e);
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
        reject(new Error('Factoid stream connection failed'));
      };
    });
  }, []);

  /**
   * Search suggestions for autocomplete (lightweight, no state changes)
   */
  const searchSuggest = useCallback(async (
    query: string,
    limit: number = 5
  ): Promise<SearchCandidate[]> => {
    // Skip if query too short
    if (!query || query.length < 2) {
      return [];
    }

    try {
      return await fetchSuggestions(query, limit);
    } catch (error) {
      console.error('[useAgent] Search suggest error:', error);
      return [];
    }
  }, []);

  return useMemo(() => ({
    ...state,
    analyze,
    selectCandidate,
    decryptMoreFactoidsStream,
    searchSuggest,
    reset,
  }), [state, analyze, selectCandidate, decryptMoreFactoidsStream, searchSuggest, reset]);
}
