// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import PlaygroundGallery from '#routes/_index/route.js';

describe('PlaygroundGallery', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders gallery cards that open examples in the playground', () => {
    renderGallery();

    expect(screen.getByRole('heading', { name: '3D Rack System' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Network Equipment Rack' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Atmospheric Sampler' })).toBeDefined();
    // OpenCascade-derived (Replicad) projects must be visible alongside OpenSCAD ones.
    expect(screen.getByRole('heading', { name: 'Modular PET Bottle Opener (OpenCascade)' })).toBeDefined();
    // The whole card is the link, labelled per model.
    expect(screen.getByRole('link', { name: 'Open 3D Rack System' }).getAttribute('href')).toBe(
      '/playground?model=3d-rack-scad',
    );
  });

  it('exposes a per-kernel engine filter including variant-only kernels', () => {
    renderGallery();

    // Both kernels present in the gallery get their own filter chip.
    expect(screen.getByRole('button', { name: 'OpenSCAD' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'OpenCascade' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Replicad' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Static' })).toBeDefined();
  });

  it('shows every supported kernel on dual-kernel cards', () => {
    renderGallery();

    const rackCard = screen.getByRole('heading', { name: '3D Rack System' }).closest('article');
    expect(rackCard).not.toBeNull();
    expect(within(rackCard!).getByLabelText('Engines: OpenSCAD, OpenCascade')).toBeDefined();
  });

  it('matches and filters against kernels supplied only by variants', () => {
    renderGallery();

    fireEvent.change(screen.getByLabelText('Search gallery'), { target: { value: 'OpenCascade' } });
    expect(screen.getByRole('heading', { name: '3D Rack System' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Network Equipment Rack' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Search gallery'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'OpenCascade' }));
    expect(screen.getByRole('heading', { name: '3D Rack System' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Network Equipment Rack' })).toBeNull();
  });

  it('filters gallery models by search and engine', () => {
    renderGallery();

    fireEvent.change(screen.getByLabelText('Search gallery'), { target: { value: 'rack' } });

    expect(screen.getByRole('heading', { name: '3D Rack System' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'OpenSCAD bracket' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'OpenSCAD' }));

    expect(screen.getByRole('heading', { name: '3D Rack System' })).toBeDefined();

    // Switching to the Replicad engine filter hides the OpenSCAD rack and shows the opener.
    fireEvent.change(screen.getByLabelText('Search gallery'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replicad' }));

    expect(screen.queryByRole('heading', { name: '3D Rack System' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Modular PET Bottle Opener (OpenCascade)' })).toBeDefined();

    fireEvent.change(screen.getByLabelText('Search gallery'), { target: { value: 'not-a-real-model' } });

    expect(screen.getByText('No gallery models match the current filters.')).toBeDefined();
  });

  it('filters gallery models by project.json category metadata', () => {
    renderGallery();

    fireEvent.change(screen.getByLabelText('Filter by category'), { target: { value: 'Organization' } });

    expect(screen.getByRole('heading', { name: '3D Rack System' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Atmospheric Sampler' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Filter by category'), { target: { value: 'All' } });

    expect(screen.getByRole('heading', { name: 'Atmospheric Sampler' })).toBeDefined();
  });

  it('zooms a card image into a lightbox and closes it without navigating', () => {
    renderGallery();

    fireEvent.click(screen.getByRole('button', { name: 'Preview 3D Rack System' }));

    expect(screen.getByRole('dialog', { name: '3D Rack System preview' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    // The card link is untouched by the zoom interaction.
    expect(screen.getByRole('link', { name: 'Open 3D Rack System' })).toBeDefined();
  });

  it('matches search terms against project.json tags', () => {
    renderGallery();

    // "storage" only appears in tags, not in any name or description.
    fireEvent.change(screen.getByLabelText('Search gallery'), { target: { value: 'storage' } });

    expect(screen.getByRole('heading', { name: '3D Rack System' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Interlocking Boxes System' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Atmospheric Sampler' })).toBeNull();
  });
});

function renderGallery(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <PlaygroundGallery />
    </MemoryRouter>,
  );
}
