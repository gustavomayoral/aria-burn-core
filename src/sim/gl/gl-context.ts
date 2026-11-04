// SPDX-License-Identifier: MIT
// WebGL context loss and recovery (BURN-36). On Iris Xe a refused allocation
// is followed by webglcontextlost; without preventDefault the browser never
// restores the context and the canvas stays dead.
//
// Everything on the GPU is derived (samples re-upload, targets reallocate,
// overviews re-composite), so recovery is: drop the old GlSim / GlOverview /
// GlBurnView, build new ones on the restored context, re-run. A new GlSim
// starts from the tile side learned before the loss (gl-sim.ts), so the run
// that lost the context isn't repeated at the same size.

export type ContextState = 'ok' | 'lost' | 'restored'

export interface ContextHandlers {
  /** The context is gone: stop drawing and tell the user the view is being restored. */
  onLost?: (event: Event) => void
  /** The context is back, empty: rebuild GPU objects and re-run. */
  onRestored?: (event: Event) => void
}

export interface ContextWatch {
  readonly state: ContextState
  /** Times the context was lost since watching started. */
  readonly losses: number
  stop(): void
}

/**
 * Watch a canvas for context loss. Calls preventDefault on webglcontextlost so
 * the browser restores the context, then hands both events to the handlers.
 */
export function watchContextLoss(canvas: EventTarget, handlers: ContextHandlers): ContextWatch {
  let state: ContextState = 'ok'
  let losses = 0
  const lost = (e: Event) => {
    e.preventDefault()
    state = 'lost'
    losses++
    handlers.onLost?.(e)
  }
  const restored = (e: Event) => {
    state = 'restored'
    handlers.onRestored?.(e)
  }
  canvas.addEventListener('webglcontextlost', lost)
  canvas.addEventListener('webglcontextrestored', restored)
  return {
    get state() {
      return state
    },
    get losses() {
      return losses
    },
    stop() {
      canvas.removeEventListener('webglcontextlost', lost)
      canvas.removeEventListener('webglcontextrestored', restored)
    },
  }
}
