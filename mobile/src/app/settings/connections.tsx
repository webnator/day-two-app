import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useI18n } from '../../i18n';
import { useApp, useQuery } from '../../state/app';
import { api, apiBase, type McpConnection } from '../../services/api';
import { conflicts, resolveConflict } from '../../data/sync';
import { emitChange } from '../../services/events';
import { connectionsCopy } from '../../content/connectionsCopy';
import { BodyMuted, ListRow, NavHeader, PageTitle, PrimaryButton, QuietAction, SectionTitle, SecondaryButton, Separator } from '../../ui/components';
import { ConfirmSheet } from '../../ui/Sheet';
import { Screen } from '../../ui/Screen';
import { Txt } from '../../ui/Txt';

export default function Connections() {
  const { lang, t } = useI18n(), copy = connectionsCopy[lang];
  const { journal, sync, toast } = useApp();
  const [clients, setClients] = useState<McpConnection[]>([]), [loadFailed, setLoadFailed] = useState(false), [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: 'enable' } | { kind: 'revoke'; id: string } | { kind: 'resolve'; id: string; choice: 'local' | 'remote' } | null>(null);
  const state = useQuery(async j => ({ enabled: await j.get('sync.enabled', false), last: await j.get<string | null>('sync.lastContact', null), error: await j.get<string | null>('sync.error', null), conflicts: await conflicts(j) }), []);
  const load = async () => { try { const res = await api.connections(); setClients(res.connections); setLoadFailed(false); } catch { setLoadFailed(true); } };
  useEffect(() => {
    let active = true;
    api.connections().then(res => { if (active) { setClients(res.connections); setLoadFailed(false); } }, () => { if (active) setLoadFailed(true); });
    return () => { active = false; };
  }, []);
  const run = async (fn: () => Promise<unknown>) => { if (busy) return; setBusy(true); try { await fn(); emitChange(); } catch { toast(copy.error); } finally { setBusy(false); } };
  return <Screen>
    <NavHeader title={copy.title} backA11y={t('back')} onBack={() => router.back()} />
    <PageTitle>{copy.intro}</PageTitle>
    <BodyMuted>{copy.scope}</BodyMuted>
    <SectionTitle>{copy.sync}</SectionTitle>
    <BodyMuted size={16}>{state?.error ? copy.failed : state?.last ? `${copy.last}: ${new Date(state.last).toLocaleString(lang)}` : copy.fresh}</BodyMuted>
    {!state?.enabled ? <>
      {state?.last ? <BodyMuted size={16} style={{ marginTop: 12 }}>{copy.paused}</BodyMuted> : null}
      <PrimaryButton label={copy.activate} disabled={busy || !sync} onPress={() => setConfirm({ kind: 'enable' })} marginTop={24} />
    </> : <>
      <PrimaryButton label={busy ? copy.running : copy.now} disabled={busy} marginTop={24} onPress={() => run(async () => { await sync?.runNow(); await load(); })} />
      <SecondaryButton label={copy.pause} disabled={busy} onPress={() => run(async () => { await sync?.setEnabled(false); })} />
    </>}
    <SectionTitle>{copy.address}</SectionTitle>
    <Txt size={17} selectable style={{ marginBottom: 12 }}>{apiBase() + '/mcp'}</Txt>
    <BodyMuted size={16}>{copy.instructions}</BodyMuted>
    <SectionTitle>{copy.clients}</SectionTitle>
    {loadFailed ? <><BodyMuted>{copy.loadFailed}</BodyMuted><QuietAction label={copy.retry} onPress={load} /></> : clients.length ? clients.map(c => <View key={c.id}>
      <ListRow title={c.name} sub={c.scopes.includes('journal:write') ? copy.write : copy.read} chevron={false} />
      <QuietAction label={copy.revoke} disabled={busy} onPress={() => setConfirm({ kind: 'revoke', id: c.id })} />
    </View>) : <BodyMuted>{copy.empty}</BodyMuted>}
    {state?.conflicts.length ? <>
      <SectionTitle>{copy.conflicts}</SectionTitle><BodyMuted>{copy.conflictText}</BodyMuted>
      {state.conflicts.map(c => <View key={c.id} style={{ marginTop: 24 }}>
        <Separator /><SectionTitle size={22}>{c.local?.title || c.remote.entry?.title || c.id}</SectionTitle>
        <Txt size={16}>{copy.local}</Txt><BodyMuted size={16}>{c.local ? `${c.local.day} · ${c.local.title}\n${c.local.body}\n${c.local.tags.map(t => t.name).join(' · ')}` : copy.deleted}</BodyMuted>
        <Txt size={16} style={{ marginTop: 20 }}>{copy.remote}</Txt><BodyMuted size={16}>{c.remote.entry ? `${c.remote.entry.day} · ${c.remote.entry.title}\n${c.remote.entry.body}\n${c.remote.entry.tags.map(t => t.name).join(' · ')}` : copy.deleted}</BodyMuted>
        <QuietAction label={copy.keepLocal} disabled={busy} onPress={() => setConfirm({ kind: 'resolve', id: c.id, choice: 'local' })} />
        <QuietAction label={copy.keepRemote} disabled={busy} onPress={() => setConfirm({ kind: 'resolve', id: c.id, choice: 'remote' })} />
      </View>)}
    </> : null}
    <ConfirmSheet visible={!!confirm} title={confirm?.kind === 'enable' ? copy.connectQ : confirm?.kind === 'revoke' ? copy.revokeQ : copy.choiceQ}
      text={confirm?.kind === 'enable' ? copy.connectText : confirm?.kind === 'revoke' ? copy.revokeText : copy.choiceText}
      action={confirm?.kind === 'enable' ? copy.activate : confirm?.kind === 'revoke' ? copy.revoke : confirm?.choice === 'local' ? copy.keepLocal : copy.keepRemote}
      cancelLabel={t('cancel')} onClose={() => setConfirm(null)} onConfirm={() => {
        const selected = confirm; setConfirm(null); if (!selected) return;
        void run(async () => {
          if (selected.kind === 'enable') await sync?.setEnabled(true);
          else if (selected.kind === 'revoke') { await api.revokeConnection(selected.id); await load(); }
          else if (journal) { await resolveConflict(journal, selected.id, selected.choice); await sync?.runNow(); }
        });
      }} />
  </Screen>;
}
