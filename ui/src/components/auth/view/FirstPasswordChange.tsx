import { useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../../../utils/api';
import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

export default function FirstPasswordChange() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword.length < 10) return setError('新密码至少需要 10 位。');
    if (newPassword !== confirmPassword) return setError('两次输入的新密码不一致。');
    setSaving(true);
    setError('');
    const response = await api.auth.changePassword(currentPassword, newPassword);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(payload.error || '修改密码失败。');
      setSaving(false);
      return;
    }
    window.location.reload();
  };

  return (
    <AuthScreenLayout
      title="首次登录：修改密码"
      description="管理员提供的是一次性临时密码。设置个人密码后才能继续使用 PilotDeck。"
      footerText="修改密码会撤销此账号在其他设备上的登录"
    >
      <form className="space-y-4" onSubmit={submit}>
        <AuthInputField id="currentPassword" label="临时密码" value={currentPassword} onChange={setCurrentPassword} type="password" autoComplete="current-password" isDisabled={saving} />
        <AuthInputField id="newPassword" label="新密码" value={newPassword} onChange={setNewPassword} type="password" autoComplete="new-password" isDisabled={saving} />
        <AuthInputField id="confirmPassword" label="确认新密码" value={confirmPassword} onChange={setConfirmPassword} type="password" autoComplete="new-password" isDisabled={saving} />
        <AuthErrorAlert errorMessage={error} />
        <button type="submit" disabled={saving} className="w-full rounded-md bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {saving ? '保存中…' : '修改密码并继续'}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
