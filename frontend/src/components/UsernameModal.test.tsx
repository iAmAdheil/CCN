// Component test for UsernameModal. Verifies the auth-choice flow advances
// correctly: email submission triggers a magic-link request; "guest" path
// advances straight to username entry. The actual fetch is mocked.
//
// Note: Radix Dialog renders the content inside a portal AND keeps an
// accessibility-shadow copy in the source location (with pointer-events
// disabled). We pull elements via getAllBy* and target the last match,
// which is the live, interactive copy.

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import UsernameModal from './UsernameModal';

vi.mock('@/lib/authClient', () => ({
  requestMagicLink: vi.fn(async (_email: string) => ({ ok: true as const })),
}));

function lastInputByPlaceholder(placeholder: string): HTMLInputElement {
  const els = screen.getAllByPlaceholderText(placeholder);
  return els[els.length - 1] as HTMLInputElement;
}

function lastButton(name: RegExp): HTMLButtonElement {
  const els = screen.getAllByRole('button', { name });
  return els[els.length - 1] as HTMLButtonElement;
}

describe('UsernameModal', () => {
  it('shows the auth-choice step initially when there is no session', () => {
    render(<UsernameModal open={true} onSubmit={() => {}} />);
    expect(lastInputByPlaceholder('you@example.com')).toBeInTheDocument();
    expect(lastButton(/magic link/i)).toBeInTheDocument();
    expect(lastButton(/continue as guest/i)).toBeInTheDocument();
  });

  it('skips auth-choice when an email is already known', () => {
    render(<UsernameModal open={true} initialEmail="restored@example.com" onSubmit={() => {}} />);
    expect(lastInputByPlaceholder('Display name')).toBeInTheDocument();
    expect(screen.getAllByText(/restored@example.com/).length).toBeGreaterThan(0);
  });

  it('advances from guest to username entry on click', async () => {
    render(<UsernameModal open={true} onSubmit={() => {}} />);
    fireEvent.click(lastButton(/continue as guest/i));
    expect(lastInputByPlaceholder('Display name')).toBeInTheDocument();
  });

  it('submits a display name to onSubmit', async () => {
    const onSubmit = vi.fn();
    render(<UsernameModal open={true} initialEmail="x@y.z" onSubmit={onSubmit} />);
    const input = lastInputByPlaceholder('Display name');
    fireEvent.change(input, { target: { value: 'Alice' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Alice', 'x@y.z'));
  });

  it('triggers magic-link request and shows the sent-confirmation', async () => {
    const { requestMagicLink } = await import('@/lib/authClient');
    render(<UsernameModal open={true} onSubmit={() => {}} />);
    const input = lastInputByPlaceholder('you@example.com');
    fireEvent.change(input, { target: { value: 'me@example.com' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(requestMagicLink).toHaveBeenCalledWith('me@example.com'));
    expect(await screen.findByText(/Check your inbox/i)).toBeInTheDocument();
  });
});
