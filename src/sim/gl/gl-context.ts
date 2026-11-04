// SPDX-License-Identifier: MIT
// WebGL context loss and recovery (BURN-36). On Iris Xe a refused allocation
// is followed by webglcontextlost; without preventDefault the browser never
// restores the context and the canvas stays dead.
//
// Everything on the GPU is derived (samples re-upload, targets reallocate,
// overviews re-composite), so recovery is: drop the old GlSim / GlOverview /
// GlBurnView, build new ones on the restored context, re-run. A new GlSim
// keeps any tile side learned from real allocation failures (gl-sim.ts); a
// context loss itself teaches none, since on Iris Xe it isn't a size limit.
// The GPU ledger is per context object, which survives the loss, so pass the
// context and the watch clears it on loss; otherwise the dead objects' bytes
// would shrink the tile budget after restore (BURN-39).

import { ledger } from './gl-util.ts'

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
export function watchContextLoss(canvas: EventTarget, handlers: ContextHandlers, gl?: WebGL2RenderingContext): ContextWatch {
  let state: ContextState = 'ok'
  let losses = 0
  const lost = (e: Event) => {
    e.preventDefault()
    state = 'lost'
    losses++
    if (gl) ledger(gl).clear()
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
