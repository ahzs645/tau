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
    expect(screen.getByRole('heading', { name: '3D Rack System (Original)' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Network Equipment Rack (Original)' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Custom Tray System (Original)' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Card Holder Grid (Original)' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Wham Project (Original)' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Replicad tray' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'OpenCascade direct' })).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Open' })[0]?.getAttribute('href')).toBe('/?model=3d-rack-scad');
  });

  it('filters gallery models by search and engine', () => {
    renderGallery();

    fireEvent.change(screen.getByLabelText('Search gallery'), { target: { value: 'rack' } });

    expect(screen.getByRole('heading', { name: '3D Rack System (Original)' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'OpenSCAD bracket' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'OpenSCAD' }));

    expect(screen.getByRole('heading', { name: '3D Rack System (Original)' })).toBeDefined();

    fireEvent.change(screen.getByLabelText('Search gallery'), { target: { value: 'not-a-real-model' } });

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
