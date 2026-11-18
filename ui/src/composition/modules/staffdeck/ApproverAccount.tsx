import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LogIn, LogOut } from 'lucide-react';
import AuthInputField from '../../../components/auth/view/AuthInputField';
import { Button } from '../../../components/ui/button';
import { PilotDeckDialog, PilotDeckDialogContent, PilotDeckDialogTitle } from '../../../../plugins/staffdeck-shared/vendor/dialog-primitives';
import type { useApproverSession } from './useApproverSession';

export function ApproverAccount({ session }: { session: ReturnType<typeof useApproverSession> }) {
  const { t } = useTranslation('auth');
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => { if (session.user) { setOpen(false); setPassword(''); } }, [session.user]);
  const close = (next: boolean) => { setOpen(next); if (!next) setPassword(''); };
  return <div className="flex h-10 shrink-0 items-center justify-end gap-2 border-b px-4 text-sm">
    <span>StaffDeck{session.user ? ` · ${session.user.username}` : ''}</span>
    <Button variant="ghost" size="icon" title={session.user ? t('logout.button') : t('login.submit')}
      aria-label={session.user ? t('logout.button') : t('login.submit')}
      onClick={() => session.user ? session.logout() : close(true)}>
      {session.user ? <LogOut size={16} /> : <LogIn size={16} />}
    </Button>
    <PilotDeckDialog open={open} onOpenChange={close}>
      <PilotDeckDialogContent aria-describedby={undefined} className="rounded-lg">
        <PilotDeckDialogTitle>StaffDeck</PilotDeckDialogTitle>
        <form className="grid gap-4" onSubmit={async event => {
          event.preventDefault();
          await session.login(username, password);
          setPassword('');
        }}>
          <AuthInputField id="approver-username" label={t('login.username')} value={username} onChange={setUsername}
            placeholder={t('login.placeholders.username')} isDisabled={session.loading} autoComplete="username" />
          <AuthInputField id="approver-password" label={t('login.password')} value={password} onChange={setPassword}
            placeholder={t('login.placeholders.password')} isDisabled={session.loading} type="password" autoComplete="current-password" />
          {session.error && <div role="alert">{session.error}</div>}
          <Button type="submit" disabled={session.loading || !username.trim() || !password}>
            <LogIn size={16} />{t(session.loading ? 'login.loading' : 'login.submit')}
          </Button>
        </form>
      </PilotDeckDialogContent>
    </PilotDeckDialog>
  </div>;
}
