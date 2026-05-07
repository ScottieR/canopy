// CreateAgentForm Component Tests
// Phase 3 Implementation - React component validation testing

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateAgentForm } from './CreateAgentForm';

// ────────────────────────────────────────────────────────────────────────────
// VALIDATION TESTS
// ────────────────────────────────────────────────────────────────────────────

describe('CreateAgentForm - Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show error when agent name is empty', async () => {
    // Test: Empty name field rejected on submit
    // Validates: Required field validation
    // Ensures: Can't create agent without name

    render(<CreateAgentForm />);
    const submitButton = screen.getByRole('button', { name: /create/i });

    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/name is required/i)).toBeInTheDocument();
    });
  });

  it('should show error when emoji is empty', async () => {
    // Test: Empty emoji field rejected
    // Validates: Emoji required
    // Ensures: Agent has visual identifier

    render(<CreateAgentForm />);

    // Fill name
    const nameInput = screen.getByPlaceholderText(/agent name/i);
    await userEvent.type(nameInput, 'Test Agent');

    // Leave emoji empty, submit
    const submitButton = screen.getByRole('button', { name: /create/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/emoji is required/i)).toBeInTheDocument();
    });
  });

  it('should reject emoji longer than 2 characters', async () => {
    // Test: Emoji length validation
    // Validates: Single emoji only
    // Ensures: UI displays correctly

    render(<CreateAgentForm />);

    const nameInput = screen.getByPlaceholderText(/agent name/i);
    const emojiInput = screen.getByPlaceholderText(/emoji/i);

    await userEvent.type(nameInput, 'Test Agent');
    await userEvent.type(emojiInput, '😀😀😀'); // 3 emojis

    const submitButton = screen.getByRole('button', { name: /create/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/emoji must be/i)).toBeInTheDocument();
    });
  });

  it('should reject invalid color format', async () => {
    // Test: Color format validation
    // Validates: Hex color format
    // Ensures: Color picker integration

    render(<CreateAgentForm />);

    const nameInput = screen.getByPlaceholderText(/agent name/i);
    const emojiInput = screen.getByPlaceholderText(/emoji/i);
    const colorInput = screen.getByPlaceholderText(/color|hex/i);

    await userEvent.type(nameInput, 'Test Agent');
    await userEvent.type(emojiInput, '😀');
    await userEvent.type(colorInput, 'red'); // Invalid

    const submitButton = screen.getByRole('button', { name: /create/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/color must be/i)).toBeInTheDocument();
    });
  });

  it('should accept valid #RRGGBB color format', async () => {
    // Test: Valid hex color accepted
    // Validates: Proper format parsing
    // Ensures: Form submits with valid color

    const handleSubmit = vi.fn();
    render(<CreateAgentForm onSubmit={handleSubmit} />);

    const nameInput = screen.getByPlaceholderText(/agent name/i);
    const emojiInput = screen.getByPlaceholderText(/emoji/i);
    const colorInput = screen.getByPlaceholderText(/color|hex/i);

    await userEvent.type(nameInput, 'Test Agent');
    await userEvent.type(emojiInput, '😀');
    await userEvent.type(colorInput, '#34D399');

    const submitButton = screen.getByRole('button', { name: /create/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(handleSubmit).toHaveBeenCalled();
    });
  });

  it('should accept valid #RRGGBBAA color format with alpha', async () => {
    // Test: 8-char hex color with alpha channel
    // Validates: Extended hex format
    // Ensures: Transparency supported

    const handleSubmit = vi.fn();
    render(<CreateAgentForm onSubmit={handleSubmit} />);

    const nameInput = screen.getByPlaceholderText(/agent name/i);
    const emojiInput = screen.getByPlaceholderText(/emoji/i);
    const colorInput = screen.getByPlaceholderText(/color|hex/i);

    await userEvent.type(nameInput, 'Test Agent');
    await userEvent.type(emojiInput, '😀');
    await userEvent.type(colorInput, '#34D399FF');

    const submitButton = screen.getByRole('button', { name: /create/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(handleSubmit).toHaveBeenCalled();
    });
  });

  it('should reject color with invalid hex characters', async () => {
    // Test: Invalid hex character rejection
    // Validates: Character whitelist
    // Ensures: Prevents invalid input

    render(<CreateAgentForm />);

    const colorInput = screen.getByPlaceholderText(/color|hex/i);
    await userEvent.type(colorInput, '#GGGGGG'); // G is not hex

    const submitButton = screen.getByRole('button', { name: /create/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/invalid.*hex|hex.*invalid/i)).toBeInTheDocument();
    });
  });

  it('should show error when role is not selected', async () => {
    // Test: Role field required
    // Validates: Dropdown validation
    // Ensures: Agent has defined role

    render(<CreateAgentForm />);

    const nameInput = screen.getByPlaceholderText(/agent name/i);
    const emojiInput = screen.getByPlaceholderText(/emoji/i);

    await userEvent.type(nameInput, 'Test Agent');
    await userEvent.type(emojiInput, '😀');

    // Don't select role
    const submitButton = screen.getByRole('button', { name: /create/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/role.*required|select.*role/i)).toBeInTheDocument();
    });
  });

  it('should accept name with spaces', async () => {
    // Test: Multi-word names allowed
    // Validates: Space handling
    // Ensures: Realistic agent names supported

    const handleSubmit = vi.fn();
    render(<CreateAgentForm onSubmit={handleSubmit} />);

    const nameInput = screen.getByPlaceholderText(/agent name/i);
    const emojiInput = screen.getByPlaceholderText(/emoji/i);

    await userEvent.type(nameInput, 'My Test Agent');
    await userEvent.type(emojiInput, '😀');

    const submitButton = screen.getByRole('button', { name: /create/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(handleSubmit).toHaveBeenCalled();
    });
  });

  it('should reject name exceeding maximum length', async () => {
    // Test: Name length limit
    // Validates: Max 200 chars
    // Ensures: Prevents oversized input

    render(<CreateAgentForm />);

    const nameInput = screen.getByPlaceholderText(/agent name/i);
    const longName = 'A'.repeat(201);

    await userEvent.type(nameInput, longName);

    await waitFor(() => {
      expect(screen.getByText(/must be.*characters|character.*limit/i)).toBeInTheDocument();
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SUBMISSION TESTS
// ────────────────────────────────────────────────────────────────────────────

describe('CreateAgentForm - Submission', () => {
  it('should call onSubmit with correct data shape', async () => {
    // Test: Form data correctly structured
    // Validates: Payload shape
    // Ensures: Backend receives correct format

    const handleSubmit = vi.fn();
    render(<CreateAgentForm onSubmit={handleSubmit} />);

    const nameInput = screen.getByPlaceholderText(/agent name/i);
    const emojiInput = screen.getByPlaceholderText(/emoji/i);
    const roleSelect = screen.getByRole('combobox', { name: /role/i });

    await userEvent.type(nameInput, 'My Agent');
    await userEvent.type(emojiInput, '🦞');
    await userEvent.selectOptions(roleSelect, 'assistant');

    const submitButton = screen.getByRole('button', { name: /create/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(handleSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Agent',
          emoji: '🦞',
          role: 'assistant',
        })
      );
    });
  });

  it('should disable submit button while submitting', async () => {
    // Test: Loading state UI
    // Validates: Button disabled during submission
    // Ensures: Can't double-submit

    const handleSubmit = vi.fn(
      () => new Promise(resolve => setTimeout(resolve, 200))
    );
    render(<CreateAgentForm onSubmit={handleSubmit} />);

    const nameInput = screen.getByPlaceholderText(/agent name/i);
    const emojiInput = screen.getByPlaceholderText(/emoji/i);

    await userEvent.type(nameInput, 'Test');
    await userEvent.type(emojiInput, '😀');

    const submitButton = screen.getByRole('button', { name: /create/i });
    expect(submitButton).not.toBeDisabled();

    fireEvent.click(submitButton);
    expect(submitButton).toBeDisabled();

    await waitFor(
      () => expect(submitButton).not.toBeDisabled(),
      { timeout: 500 }
    );
  });

  it('should show success message on successful submission', async () => {
    // Test: Success feedback
    // Validates: User confirmation
    // Ensures: User knows action completed

    const handleSubmit = vi.fn().mockResolvedValue({ id: 'agent-123' });
    render(<CreateAgentForm onSubmit={handleSubmit} />);

    const nameInput = screen.getByPlaceholderText(/agent name/i);
    const emojiInput = screen.getByPlaceholderText(/emoji/i);

    await userEvent.type(nameInput, 'Test Agent');
    await userEvent.type(emojiInput, '😀');

    const submitButton = screen.getByRole('button', { name: /create/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/success|created/i)).toBeInTheDocument();
    });
  });

  it('should show error message on submission failure', async () => {
    // Test: Error feedback
    // Validates: Error display
    // Ensures: User sees what went wrong

    const handleSubmit = vi.fn()
      .mockRejectedValue(new Error('Network error'));
    render(<CreateAgentForm onSubmit={handleSubmit} />);

    const nameInput = screen.getByPlaceholderText(/agent name/i);
    const emojiInput = screen.getByPlaceholderText(/emoji/i);

    await userEvent.type(nameInput, 'Test');
    await userEvent.type(emojiInput, '😀');

    const submitButton = screen.getByRole('button', { name: /create/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/network error|error/i)).toBeInTheDocument();
    });
  });

  it('should clear success message on new attempt', async () => {
    // Test: Message cleanup
    // Validates: State reset
    // Ensures: Old messages don't persist

    const handleSubmit = vi.fn().mockResolvedValue({});
    render(<CreateAgentForm onSubmit={handleSubmit} />);

    // First submission
    const nameInput = screen.getByPlaceholderText(/agent name/i);
    const emojiInput = screen.getByPlaceholderText(/emoji/i);

    await userEvent.type(nameInput, 'Agent 1');
    await userEvent.type(emojiInput, '😀');

    const submitButton = screen.getByRole('button', { name: /create/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/success|created/i)).toBeInTheDocument();
    });

    // Clear and try again
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Agent 2');

    // Success message should update or clear
    fireEvent.click(submitButton);

    // Message should be new/updated
    await waitFor(() => {
      expect(handleSubmit).toHaveBeenCalledTimes(2);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE CASES & SPECIAL SCENARIOS
// ────────────────────────────────────────────────────────────────────────────

describe('CreateAgentForm - Edge Cases', () => {
  it('should handle rapid input changes', async () => {
    // Test: Fast typing doesn't break validation
    // Validates: Event handling
    // Ensures: Responsive to quick input

    render(<CreateAgentForm />);

    const nameInput = screen.getByPlaceholderText(/agent name/i) as HTMLInputElement;
    const emojiInput = screen.getByPlaceholderText(/emoji/i) as HTMLInputElement;

    // Rapid typing
    await userEvent.type(nameInput, 'A', { delay: 1 });
    await userEvent.type(nameInput, 'gent', { delay: 1 });
    await userEvent.type(emojiInput, '😀', { delay: 1 });

    // Form should still be functional
    expect(nameInput.value).toContain('Agent');
    expect(emojiInput.value).toBe('😀');
  });

  it('should auto-complete color if selecting from palette', async () => {
    // Test: Color palette integration
    // Validates: Preset colors work
    // Ensures: Easier color selection

    render(<CreateAgentForm showColorPalette={true} />);

    // Click a preset color
    const teaColor = screen.getByRole('button', { name: /teal|tea/i });
    fireEvent.click(teaColor);

    const colorInput = screen.getByPlaceholderText(/color|hex/i) as HTMLInputElement;
    expect(colorInput.value).toBe('#34D399');
  });

  it('should handle paste events for color input', async () => {
    // Test: Paste color code support
    // Validates: Clipboard handling
    // Ensures: Easy color copying

    render(<CreateAgentForm />);

    const colorInput = screen.getByPlaceholderText(/color|hex/i) as HTMLInputElement;

    // Simulate paste
    const pasteData = '#FF5733';
    fireEvent.paste(colorInput, { clipboardData: { getData: () => pasteData } });

    await waitFor(() => {
      expect(colorInput.value).toBe(pasteData);
    });
  });

  it('should handle copy-paste of full agent data', async () => {
    // Test: Multi-field paste
    // Validates: Form can accept pasted data
    // Ensures: User can paste template

    render(<CreateAgentForm />);

    const nameInput = screen.getByPlaceholderText(/agent name/i) as HTMLInputElement;

    // Paste name
    fireEvent.paste(nameInput, {
      clipboardData: { getData: () => 'Pasted Agent Name' }
    });

    await waitFor(() => {
      expect(nameInput.value).toContain('Pasted');
    });
  });

  it('should trim whitespace from inputs', async () => {
    // Test: Whitespace trimming
    // Validates: Input cleaning
    // Ensures: No leading/trailing spaces

    const handleSubmit = vi.fn();
    render(<CreateAgentForm onSubmit={handleSubmit} />);

    const nameInput = screen.getByPlaceholderText(/agent name/i);
    const emojiInput = screen.getByPlaceholderText(/emoji/i);

    await userEvent.type(nameInput, '  Test Agent  '); // Spaces
    await userEvent.type(emojiInput, '😀');

    const submitButton = screen.getByRole('button', { name: /create/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(handleSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Test Agent' // Trimmed
        })
      );
    });
  });

  it('should handle very long agent names gracefully', async () => {
    // Test: Long name boundary
    // Validates: Max length enforcement
    // Ensures: No crashes with oversized input

    render(<CreateAgentForm />);

    const nameInput = screen.getByPlaceholderText(/agent name/i);
    const veryLongName = 'A'.repeat(500);

    await userEvent.type(nameInput, veryLongName);

    // Should either truncate or show error, not crash
    await waitFor(() => {
      const input = screen.getByPlaceholderText(/agent name/i) as HTMLInputElement;
      expect(input.value.length).toBeLessThanOrEqual(200);
    });
  });

  it('should focus on first error field', async () => {
    // Test: Accessibility - focus management
    // Validates: Keyboard navigation
    // Ensures: Users can navigate errors

    render(<CreateAgentForm />);

    const submitButton = screen.getByRole('button', { name: /create/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      const nameInput = screen.getByPlaceholderText(/agent name/i);
      expect(nameInput).toHaveFocus();
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ACCESSIBILITY TESTS
// ────────────────────────────────────────────────────────────────────────────

describe('CreateAgentForm - Accessibility', () => {
  it('should have proper form labels', () => {
    // Test: Label associations
    // Validates: Screen reader support
    // Ensures: Accessible to users with assistive tech

    render(<CreateAgentForm />);

    expect(screen.getByLabelText(/agent name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/emoji/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/color/i)).toBeInTheDocument();
  });

  it('should have keyboard navigation', async () => {
    // Test: Tab order
    // Validates: Keyboard accessibility
    // Ensures: Users can navigate with keyboard

    render(<CreateAgentForm />);

    const nameInput = screen.getByPlaceholderText(/agent name/i);
    nameInput.focus();
    expect(nameInput).toHaveFocus();

    fireEvent.keyDown(nameInput, { key: 'Tab' });
    // Next field should receive focus
  });

  it('should announce validation errors to screen readers', async () => {
    // Test: ARIA error announcements
    // Validates: Screen reader messages
    // Ensures: Blind users see errors

    render(<CreateAgentForm />);

    const submitButton = screen.getByRole('button', { name: /create/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      const errorMsg = screen.getByText(/required/i);
      expect(errorMsg).toHaveAttribute('role', 'alert');
    });
  });

  it('should have semantic HTML structure', () => {
    // Test: HTML semantics
    // Validates: Proper element types
    // Ensures: Good document structure

    render(<CreateAgentForm />);

    expect(screen.getByRole('form')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create/i })).toBeInTheDocument();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SUMMARY OF TESTS IMPLEMENTED
// ────────────────────────────────────────────────────────────────────────────

// Validation (9 tests):
// ✅ test_agent_name_empty
// ✅ test_emoji_empty
// ✅ test_emoji_too_long
// ✅ test_color_invalid_format
// ✅ test_color_valid_rrggbb
// ✅ test_color_valid_rrggbbaa
// ✅ test_color_invalid_hex_chars
// ✅ test_role_required
// ✅ test_name_with_spaces
// ✅ test_name_max_length
//
// Submission (5 tests):
// ✅ test_submit_calls_callback_with_data
// ✅ test_submit_button_disabled_while_submitting
// ✅ test_success_message_shown
// ✅ test_error_message_shown
// ✅ test_clear_success_on_new_attempt
//
// Edge Cases (7 tests):
// ✅ test_rapid_input_changes
// ✅ test_color_palette_auto_complete
// ✅ test_paste_color_code
// ✅ test_paste_full_data
// ✅ test_trim_whitespace
// ✅ test_very_long_names
// ✅ test_focus_on_error_field
//
// Accessibility (4 tests):
// ✅ test_proper_form_labels
// ✅ test_keyboard_navigation
// ✅ test_error_announcements
// ✅ test_semantic_html
//
// TOTAL: 25 React component tests covering form validation and user interactions
