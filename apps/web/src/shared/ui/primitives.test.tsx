import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Button, Field, PixelFrame, PixelIcon } from './index.js';
afterEach(cleanup);
test('field associates its label, hint and validation message', () => {
  render(
    <Field
      label="Requirement"
      hint="Hint"
      error="Required"
      data-testid="requirement"
    />,
  );
  const input = screen.getByLabelText('Requirement');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  const ids = input.getAttribute('aria-describedby')!.split(' ');
  expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([
    'Hint',
    'Required',
  ]);
});
test('button defaults to non-submitting and honors disabled', () => {
  const onClick = vi.fn();
  render(
    <PixelFrame>
      <Button
        aria-label="Approve"
        data-testid="approve"
        disabled
        onClick={onClick}
      >
        <PixelIcon name="check" />
        Approve
      </Button>
    </PixelFrame>,
  );
  fireEvent.click(screen.getByTestId('approve'));
  expect(onClick).not.toHaveBeenCalled();
  expect(screen.getByTestId('approve').getAttribute('type')).toBe('button');
});
