import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AgentLog } from '../types';
import SystemConsole from './SystemConsole';

const log = (code: AgentLog['code']): AgentLog => ({
  id: String(code),
  message: 'Composing the liner notes...',
  timestamp: '2026-01-01T00:00:00.000Z',
  code,
});

describe('SystemConsole', () => {
  it.each(['LLM-CONNECT', 'LLM-ERROR', 'GEMINI-CONNECT'] as const)(
    'colours the model code %s as a model step',
    (code) => {
      render(<SystemConsole logs={[log(code)]} isComplete />);
      expect(screen.getByText(`[${code}]`).className).toContain('text-accent-purple');
    },
  );
});
