import { registerRootComponent } from 'expo';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  FlatList,
  Image,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  TextInput,
  BackHandler
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useKeepAwake } from 'expo-keep-awake';
import { decode as atob } from 'base-64';
import utf8 from 'utf8';

// ==========================================
// Types & Interfaces
// ==========================================

interface Category { id: number; name: string; image: string; }
interface Channel { id: number; name: string; image: string; }
interface StreamData { url: string; referer?: string; user_agent?: string; }
type ScreenState = 
  | { name: 'HOME' }
  | { name: 'CATEGORY'; id: number; title: string }
  | { name: 'PLAYER'; id: number; title: string };

// ==========================================
// Config & Security
// ==========================================

const API_BASE = 'https://def.ycnapi.com/api';
const SECRET_BASE_KEY = 'c!xZj+N9&G@Ev@vw';
const DEFAULT_USER_AGENT = 'okhttp/4.12.0';

const COLORS = {
  background: '#F2F2F7', card: '#FFFFFF', textPrimary: '#111111',
  textSecondary: '#6E6E73', accent: '#007AFF', playerBg: '#000000',
  error: '#FF3B30', divider: '#E5E5EA',
};

const Cache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; 

const decryptPayload = (encryptedBase64: string, tHeader: string): unknown => {
  try {
    const finalKey = SECRET_BASE_KEY + tHeader;
    const decodedBytes = atob(encryptedBase64);
    let xorResult = '';
    for (let i = 0; i < decodedBytes.length; i++) {
      xorResult += String.fromCharCode(decodedBytes.charCodeAt(i) ^ finalKey.charCodeAt(i % finalKey.length));
    }
    return JSON.parse(utf8.decode(xorResult));
  } catch {
    throw new Error('Data Decryption Failed');
  }
};

const fetchWithTimeout = async (url: string, options: RequestInit, timeoutMs = 10000) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
};

const apiRequest = async <T,>(endpoint: string, bypassCache = false): Promise<T> => {
  const url = `${API_BASE}${endpoint}`;
  if (!bypassCache && Cache.has(url) && Date.now() - Cache.get(url)!.timestamp < CACHE_TTL) {
    return Cache.get(url)!.data as T;
  }
  const response = await fetchWithTimeout(url, {
    headers: { 'User-Agent': DEFAULT_USER_AGENT, 'Accept': 'application/json' },
  });
  if (!response.ok) throw new Error('HTTP Error');
  const tHeader = response.headers.get('t');
  if (!tHeader) throw new Error('Missing authentication header');
  const textPayload = await response.text();
  const parsedData = decryptPayload(textPayload, tHeader) as { data: T };
  if (!parsedData || !parsedData.data) throw new Error('Malformed API response');
  Cache.set(url, { data: parsedData.data, timestamp: Date.now() });
  return parsedData.data;
};

// ==========================================
// UI Components
// ==========================================

const Header = ({ title, onBack }: { title: string; onBack?: () => void }) => (
  <View style={styles.header}>
    {onBack && (
      <TouchableOpacity onPress={onBack} style={styles.backButton}>
        <Ionicons name="chevron-back" size={28} color={COLORS.accent} />
      </TouchableOpacity>
    )}
    <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
    {onBack && <View style={{ width: 40 }} />}
  </View>
);

const ErrorView = ({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <View style={styles.centerContainer}>
    <Ionicons name="warning-outline" size={48} color={COLORS.error} />
    <Text style={styles.errorText}>{message}</Text>
    <TouchableOpacity style={styles.retryButton} onPress={onRetry}>
      <Text style={styles.retryButtonText}>إعادة المحاولة</Text>
    </TouchableOpacity>
  </View>
);

// ==========================================
// Screens
// ==========================================

const HomeScreen = ({ onSelect }: { onSelect: (id: number, title: string) => void }) => {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async (force = false) => {
    setLoading(true); setError(null);
    try { setCategories(await apiRequest<Category[]>('/categories', force)); } 
    catch { setError('تعذر الاتصال بالخادم. يرجى التحقق من الشبكة.'); } 
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  return (
    <View style={styles.screen}>
      <Header title="Enlil Live" />
      {loading ? <ActivityIndicator style={styles.centerContainer} size="large" color={COLORS.accent} /> :
       error ? <ErrorView message={error} onRetry={() => loadData(true)} /> :
       <FlatList
         data={categories}
         keyExtractor={i => i.id.toString()}
         contentContainerStyle={styles.listContent}
         refreshing={loading}
         onRefresh={() => loadData(true)}
         renderItem={({ item }) => (
           <TouchableOpacity style={styles.card} onPress={() => onSelect(item.id, item.name)} activeOpacity={0.7}>
             <Image source={{ uri: item.image }} style={styles.cardImage} />
             <View style={styles.cardOverlay}><Text style={styles.cardTitle}>{item.name}</Text></View>
           </TouchableOpacity>
         )}
       />}
    </View>
  );
};

const CategoryScreen = ({ categoryId, title, onBack, onSelectChannel }: { categoryId: number; title: string; onBack: () => void; onSelectChannel: (id: number, title: string) => void; }) => {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const loadData = useCallback(async (force = false) => {
    setLoading(true); setError(null);
    try { setChannels(await apiRequest<Channel[]>(`/categories/${categoryId}/channels`, force)); } 
    catch { setError('تعذر قراءة بيانات القنوات.'); } 
    finally { setLoading(false); }
  }, [categoryId]);

  useEffect(() => { loadData(); }, [loadData]);

  const filtered = useMemo(() => search.trim() ? channels.filter(c => c.name.toLowerCase().includes(search.toLowerCase().trim())) : channels, [channels, search]);

  return (
    <View style={styles.screen}>
      <Header title={title} onBack={onBack} />
      <View style={styles.searchContainer}>
        <Ionicons name="search" size={20} color={COLORS.textSecondary} />
        <TextInput style={styles.searchInput} placeholder="بحث عن قناة..." placeholderTextColor={COLORS.textSecondary} value={search} onChangeText={setSearch} />
      </View>
      {loading ? <ActivityIndicator style={styles.centerContainer} size="large" color={COLORS.accent} /> :
       error ? <ErrorView message={error} onRetry={() => loadData(true)} /> :
       filtered.length === 0 ? <View style={styles.centerContainer}><Text style={styles.textSecondary}>لا توجد قنوات مطابقة</Text></View> :
       <FlatList
         data={filtered}
         keyExtractor={i => i.id.toString()}
         contentContainerStyle={styles.listContent}
         refreshing={loading}
         onRefresh={() => loadData(true)}
         renderItem={({ item }) => (
           <TouchableOpacity style={styles.channelRow} onPress={() => onSelectChannel(item.id, item.name)}>
             <Image source={{ uri: item.image }} style={styles.channelAvatar} />
             <Text style={styles.channelName}>{item.name}</Text>
             <Ionicons name="play-circle-outline" size={24} color={COLORS.accent} />
           </TouchableOpacity>
         )}
       />}
    </View>
  );
};

const PlayerScreen = ({ channelId, title, onBack }: { channelId: number; title: string; onBack: () => void }) => {
  useKeepAwake();
  const [streamData, setStreamData] = useState<StreamData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const fetchStream = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await apiRequest<StreamData[]>(`/channel/${channelId}`, true);
      if (data?.[0]?.url) setStreamData(data[0]); else throw new Error();
    } catch { setError('تعذر تشغيل البث. قد يكون الرابط منتهي الصلاحية.'); } 
    finally { setLoading(false); }
  }, [channelId]);

  useEffect(() => { fetchStream(); }, [fetchStream]);

  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (isFullscreen) { toggleFullscreen(); return true; }
      onBack(); return true;
    });
    return () => backHandler.remove();
  }, [isFullscreen, onBack]);

  const player = useVideoPlayer(streamData ? { uri: streamData.url, headers: { 'User-Agent': streamData.user_agent || DEFAULT_USER_AGENT, ...(streamData.referer ? { 'Referer': streamData.referer } : {}) } } : null, p => { p.play(); });

  const toggleFullscreen = async () => {
    if (!isFullscreen) await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
    else await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    setIsFullscreen(!isFullscreen);
  };

  useEffect(() => () => { ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP); }, []);

  return (
    <View style={[styles.screen, { backgroundColor: COLORS.playerBg }]}>
      <StatusBar hidden={isFullscreen} style="light" />
      {!isFullscreen && (
        <SafeAreaView>
          <View style={[styles.header, { backgroundColor: COLORS.playerBg, borderBottomWidth: 0 }]}>
            <TouchableOpacity onPress={onBack} style={styles.backButton}><Ionicons name="chevron-back" size={28} color="#FFF" /></TouchableOpacity>
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, justifyContent: 'center' }}>
              <View style={styles.liveIndicator} /><Text style={[styles.headerTitle, { color: '#FFF' }]} numberOfLines={1}>{title}</Text>
            </View><View style={{ width: 40 }} />
          </View>
        </SafeAreaView>
      )}
      <View style={styles.playerContainer}>
        {loading ? <ActivityIndicator size="large" color={COLORS.accent} /> :
         error ? <ErrorView message={error} onRetry={fetchStream} /> :
         <VideoView player={player} style={styles.videoView} contentFit="contain" allowsFullscreen nativeControls />}
      </View>
      {!isFullscreen && streamData && !error && (
        <View style={styles.playerInfoCard}>
          <Text style={styles.playerInfoTitle}>{title}</Text>
          <Text style={styles.playerInfoSubtitle}>جاري البث المباشر الآن...</Text>
          <TouchableOpacity style={styles.fullscreenBtn} onPress={toggleFullscreen}>
            <Ionicons name="expand" size={20} color={COLORS.accent} />
            <Text style={{ color: COLORS.accent, marginLeft: 8, fontWeight: '600' }}>تكبير الشاشة</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
};

// ==========================================
// Main App Root
// ==========================================

export default function App() {
  const [screen, setScreen] = useState<ScreenState>({ name: 'HOME' });

  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen.name !== 'HOME') { setScreen({ name: 'HOME' }); return true; }
      return false;
    });
    return () => backHandler.remove();
  }, [screen]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: screen.name === 'PLAYER' ? COLORS.playerBg : COLORS.background }}>
      <StatusBar style={screen.name === 'PLAYER' ? "light" : "dark"} />
      {screen.name === 'HOME' && <HomeScreen onSelect={(id, title) => setScreen({ name: 'CATEGORY', id, title })} />}
      {screen.name === 'CATEGORY' && <CategoryScreen categoryId={screen.id} title={screen.title} onBack={() => setScreen({ name: 'HOME' })} onSelectChannel={(id, title) => setScreen({ name: 'PLAYER', id, title })} />}
      {screen.name === 'PLAYER' && <PlayerScreen channelId={screen.id} title={screen.title} onBack={() => setScreen({ name: 'HOME' })} />}
    </SafeAreaView>
  );
}

registerRootComponent(App);

// ==========================================
// Styles
// ==========================================

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: COLORS.background, borderBottomWidth: 1, borderBottomColor: COLORS.divider },
  headerTitle: { fontSize: 18, fontWeight: '700', color: COLORS.textPrimary, flex: 1, textAlign: 'center' },
  backButton: { padding: 4 },
  listContent: { padding: 16, gap: 16 },
  card: { backgroundColor: COLORS.card, borderRadius: 20, overflow: 'hidden', height: 160, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 12, elevation: 3 },
  cardImage: { width: '100%', height: '100%', position: 'absolute' },
  cardOverlay: { position: 'absolute', bottom: 0, width: '100%', padding: 16, backgroundColor: 'rgba(0,0,0,0.6)' },
  cardTitle: { color: '#FFF', fontSize: 20, fontWeight: 'bold' },
  searchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.card, margin: 16, paddingHorizontal: 16, borderRadius: 16, height: 44 },
  searchInput: { flex: 1, marginLeft: 8, fontSize: 16, color: COLORS.textPrimary },
  channelRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.card, padding: 12, borderRadius: 18 },
  channelAvatar: { width: 48, height: 48, borderRadius: 12, backgroundColor: COLORS.divider },
  channelName: { flex: 1, marginLeft: 16, fontSize: 16, fontWeight: '600', color: COLORS.textPrimary },
  playerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.playerBg },
  videoView: { width: '100%', height: '100%' },
  playerInfoCard: { backgroundColor: COLORS.card, margin: 16, padding: 20, borderRadius: 24, alignItems: 'center' },
  playerInfoTitle: { fontSize: 20, fontWeight: 'bold', color: COLORS.textPrimary, marginBottom: 4 },
  playerInfoSubtitle: { fontSize: 14, color: COLORS.textSecondary, marginBottom: 16 },
  fullscreenBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: `${COLORS.accent}15`, paddingVertical: 10, paddingHorizontal: 20, borderRadius: 12 },
  liveIndicator: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.error, marginRight: 8 },
  errorText: { marginTop: 16, fontSize: 16, color: COLORS.textSecondary, textAlign: 'center' },
  retryButton: { marginTop: 24, backgroundColor: COLORS.accent, paddingVertical: 12, paddingHorizontal: 24, borderRadius: 12 },
  retryButtonText: { color: '#FFF', fontWeight: '600', fontSize: 16 },
  textSecondary: { color: COLORS.textSecondary, fontSize: 16 }
});
