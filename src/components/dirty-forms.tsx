'use client'

import { useEffect } from 'react'

// Unsaved changes show on the button (Himal, 21 Aug: "kay change kel ki
// button green zal pahije"). One listener for the whole app: the first
// time a form is touched its values are remembered; from then on, every
// keystroke or pick compares the form against that memory and marks its
// Save button(s) while they differ. Submitting adopts the submitted values
// as the new memory — what was just saved is, by definition, not a
// change any more.
//
// Values are read off the controls, not off defaultValue: the comboboxes
// are controlled inputs, and React keeps a controlled input's default in
// step with its value, which would make them look never-changed.

const SKIP = new Set(['submit', 'button', 'reset', 'file', 'image'])

function snapshot(form: HTMLFormElement): string {
  const parts: string[] = []
  Array.from(form.elements).forEach((el, i) => {
    const c = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    const type = (c as HTMLInputElement).type
    if (SKIP.has(type)) return
    // unnamed controls count too — a combobox's visible text box carries
    // no name (its hidden twin does), yet what is typed there IS the edit
    const key = c.name || `#${i}`
    if (type === 'checkbox' || type === 'radio') {
      parts.push(`${key}=${(c as HTMLInputElement).checked ? '1' : '0'}`)
    } else if (c instanceof HTMLSelectElement && c.multiple) {
      parts.push(`${key}=${Array.from(c.selectedOptions).map((o) => o.value).join(',')}`)
    } else {
      parts.push(`${key}=${c.value}`)
    }
  })
  return parts.join('\n')
}

function isSubmit(el: Element): boolean {
  return (
    (el instanceof HTMLButtonElement && el.type === 'submit') ||
    (el instanceof HTMLInputElement && el.type === 'submit')
  )
}

function paint(form: HTMLFormElement, dirty: boolean) {
  if (dirty) form.setAttribute('data-dirty', 'true')
  else form.removeAttribute('data-dirty')
  for (const el of Array.from(form.elements)) {
    if (!isSubmit(el)) continue
    if (dirty) el.setAttribute('data-dirty', 'true')
    else el.removeAttribute('data-dirty')
  }
}

function formOf(target: EventTarget | null): HTMLFormElement | null {
  if (!(target instanceof Element)) return null
  const owner = (target as HTMLInputElement).form
  if (owner instanceof HTMLFormElement) return owner
  return target.closest('form')
}

export function DirtyFormWatcher() {
  useEffect(() => {
    const baseline = new WeakMap<HTMLFormElement, string>()
    const remember = (form: HTMLFormElement) => {
      if (!baseline.has(form)) baseline.set(form, snapshot(form))
    }
    // Remember every form as it appears — at mount, and whenever one is
    // added later — so the memory predates any edit. Focus and pointer
    // are kept as a fallback for a form that slipped past the observer.
    const rememberAll = (root: ParentNode) => {
      if (root instanceof HTMLFormElement) remember(root)
      root.querySelectorAll('form').forEach(remember)
    }
    rememberAll(document)
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          if (n instanceof Element) rememberAll(n)
        })
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    const onTouch = (e: Event) => {
      const form = formOf(e.target)
      if (form) remember(form)
    }
    const onEdit = (e: Event) => {
      const form = formOf(e.target)
      if (!form) return
      remember(form)
      const check = () => paint(form, snapshot(form) !== baseline.get(form))
      check()
      // this listener runs before React's: a combobox's hidden twin is
      // only updated once React has handled the same event, so look once
      // more after it has
      setTimeout(check, 0)
    }
    const onSubmit = (e: Event) => {
      const form = e.target
      if (!(form instanceof HTMLFormElement)) return
      baseline.set(form, snapshot(form))
      paint(form, false)
    }
    const onReset = (e: Event) => {
      const form = e.target
      if (!(form instanceof HTMLFormElement)) return
      // the reset has not happened yet when the event fires
      setTimeout(() => {
        baseline.set(form, snapshot(form))
        paint(form, false)
      }, 0)
    }
    document.addEventListener('focusin', onTouch, true)
    document.addEventListener('pointerdown', onTouch, true)
    document.addEventListener('input', onEdit, true)
    document.addEventListener('change', onEdit, true)
    document.addEventListener('submit', onSubmit, true)
    document.addEventListener('reset', onReset, true)
    return () => {
      observer.disconnect()
      document.removeEventListener('focusin', onTouch, true)
      document.removeEventListener('pointerdown', onTouch, true)
      document.removeEventListener('input', onEdit, true)
      document.removeEventListener('change', onEdit, true)
      document.removeEventListener('submit', onSubmit, true)
      document.removeEventListener('reset', onReset, true)
    }
  }, [])
  return null
}
