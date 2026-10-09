import { renderProfileForm } from './profile-form.js'

export function renderProfileSetup(container, onDone) {
  renderProfileForm(container, {
    title: 'Welcome!',
    subtitle: 'Set up your profile',
    onDone
  })
}
