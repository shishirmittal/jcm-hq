import { getCurrentProfile } from './supabase.js'
import { renderProfileForm } from './profile-form.js'

export async function renderProfileEdit(container, onDone) {
  const profile = await getCurrentProfile()
  renderProfileForm(container, {
    profile,
    title: 'Edit profile',
    subtitle: 'Update your details',
    onDone,
    onCancel: onDone
  })
}
