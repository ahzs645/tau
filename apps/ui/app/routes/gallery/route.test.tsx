// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import PlaygroundGallery from '#routes/gallery/route.js';

describe('PlaygroundGallery', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders gallery cards that open examples in the root playground', () => {
    renderGallery();

    expect(screen.getByRole('heading', { name: 'Tau CAD Gallery' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'OpenSCAD bracket' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Replicad tray' })).toBeDefined();
    expect(screen.getAllByRole('link', { name: 'Open' })[0]?.getAttribute('href')).toBe('/?model=openscad-bracket');
  });

  it('filters gallery models by search and engine', () => {
    renderGallery();

    fireEvent.change(screen.getByLabelText('Search gallery'), { target: { value: 'tray' } });

    expect(screen.getByRole('heading', { name: 'Replicad tray' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'OpenSCAD bracket' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'OpenSCAD' }));

    expect(screen.getByText('No gallery models match the current filters.')).toBeDefined();
  });
});

function renderGallery(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <PlaygroundGallery />
    </MemoryRouter>,
  );
}
