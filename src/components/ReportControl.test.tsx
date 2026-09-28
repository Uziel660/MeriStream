/**
 * @vitest-environment jsdom
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportControl } from './ReportControl';

afterEach(() => cleanup());

describe('ReportControl controlled visibility', () => {
  it('opens and closes through its owner so native Back can dismiss the top layer', () => {
    const onOpenChange = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <ReportControl
          title="Prueba"
          open={open}
          onOpenChange={(nextOpen) => {
            onOpenChange(nextOpen);
            setOpen(nextOpen);
          }}
        />
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Reportar un problema con Prueba' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar reporte' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('keeps its existing internal open and Escape close behavior when uncontrolled', () => {
    render(<ReportControl title="Prueba" />);
    fireEvent.click(screen.getByRole('button', { name: 'Reportar un problema con Prueba' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
