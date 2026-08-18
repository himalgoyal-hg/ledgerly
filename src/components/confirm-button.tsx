'use client'

// Submit button that asks before firing its form — for destructive actions.
// Lives outside the form's server action so the action stays a plain
// progressive-enhancement form post when JS is off (no confirm, still works).
export function ConfirmButton(props: {
  message: string
  className?: string
  children: React.ReactNode
  /** Submitted with the form, so one form can carry several confirmed ops. */
  name?: string
  value?: string
}) {
  return (
    <button
      type="submit"
      name={props.name}
      value={props.value}
      onClick={(e) => {
        if (!window.confirm(props.message)) e.preventDefault()
      }}
      className={props.className}
    >
      {props.children}
    </button>
  )
}
