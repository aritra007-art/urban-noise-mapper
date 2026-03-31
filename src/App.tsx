import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  collection, 
  addDoc, 
  onSnapshot, 
  query, 
  orderBy, 
  limit, 
  getDocFromServer, 
  doc,
  deleteDoc,
  writeBatch,
  getDocs,
  where
} from 'firebase/firestore';
import { 
  Mic, 
  MicOff, 
  Map as MapIcon, 
  MapPin,
  Upload, 
  Download, 
  Trash2, 
  Activity,
  AlertCircle,
  Info,
  Settings,
  X,
  UserCircle,
  ChevronDown,
  Check,
  Leaf,
  Bird,
  Trees,
  Flower
} from 'lucide-react';
import * as d3 from 'd3';
import Papa from 'papaparse';
import { useDropzone } from 'react-dropzone';
import { motion, AnimatePresence } from 'motion/react';

import { 
  MapContainer, 
  TileLayer, 
  Circle, 
  Popup, 
  useMap 
} from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

import { db } from './firebase';
import { cn } from './lib/utils';
import { NoiseMeasurement, OperationType, FirestoreErrorInfo } from './types';

// --- Error Handling ---
function getNoiseColor(db: number) {
  return d3.scaleLinear<string>()
    .domain([0, 20, 40, 60, 80, 100, 120, 140])
    .range([
      "#10b981", // Emerald (Low)
      "#34d399", // Emerald Light
      "#fbbf24", // Amber (Med)
      "#f97316", // Orange
      "#ef4444", // Red (High)
      "#dc2626", // Red Dark
      "#7c3aed", // Violet (Extreme)
      "#4c1d95"  // Violet Dark
    ])(db);
}

function getNoiseQuality(db: number) {
  if (db < 30) return "Very Quiet";
  if (db < 60) return "Quiet";
  if (db < 80) return "Moderate";
  if (db < 100) return "Loud";
  if (db < 120) return "Very Loud";
  if (db < 140) return "Dangerous";
  return "Extreme";
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: 'public',
      email: 'public',
      emailVerified: false,
      isAnonymous: true,
      tenantId: '',
      providerInfo: []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

class ErrorBoundary extends React.Component<any, any> {
  constructor(props: any) {
    super(props);
    (this as any).state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  render() {
    const state = (this as any).state;
    if (state.hasError) {
      let errorMessage = "An unexpected error occurred.";
      try {
        const parsed = JSON.parse(state.error.message);
        if (parsed.error) errorMessage = parsed.error;
      } catch (e) {
        errorMessage = state.error.message || errorMessage;
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-900 p-6">
          <div className="max-w-md w-full bg-white border border-red-500/30 rounded-xl p-8 text-center">
            <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold mb-2">System Error</h2>
            <p className="text-slate-500 mb-6">{errorMessage}</p>
            <button 
              onClick={() => window.location.reload()}
              className="px-6 py-2 bg-red-500 hover:bg-red-600 rounded-lg transition-colors"
            >
              Restart Application
            </button>
          </div>
        </div>
      );
    }
    return (this as any).props.children;
  }
}

// --- Components ---

const FrequencySpectrum = ({ data }: { data: Uint8Array }) => {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || data.length === 0) return;

    const svg = d3.select(svgRef.current);
    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;
    const margin = { bottom: 15 };
    const chartHeight = height - margin.bottom;
    const barWidth = width / data.length;

    // Draw bars
    svg.selectAll('rect')
      .data(Array.from(data))
      .join('rect')
      .attr('x', (_, i) => i * barWidth)
      .attr('y', d => chartHeight - (d / 255) * chartHeight)
      .attr('width', Math.max(0, barWidth - 1))
      .attr('height', d => (d / 255) * chartHeight)
      .attr('fill', d => d3.interpolateTurbo(d / 255));

    // Add labels if they don't exist
    if (svg.select('.labels').empty()) {
      const labels = svg.append('g').attr('class', 'labels');
      const labelPoints = [
        { x: 0, text: '20Hz' },
        { x: width * 0.25, text: '5kHz' },
        { x: width * 0.5, text: '10kHz' },
        { x: width * 0.75, text: '15kHz' },
        { x: width, text: '20kHz', anchor: 'end' }
      ];

      labels.selectAll('text')
        .data(labelPoints)
        .enter()
        .append('text')
        .attr('x', d => d.x)
        .attr('y', height - 2)
        .attr('text-anchor', d => d.anchor || 'start')
        .attr('fill', '#64748b')
        .attr('font-size', '8px')
        .attr('font-family', 'monospace')
        .text(d => d.text);
    }
  }, [data]);

  return (
    <div className="w-full h-32 bg-slate-100/50 rounded-xl overflow-hidden border border-slate-200">
      <svg ref={svgRef} className="w-full h-full" />
    </div>
  );
};

const MapUpdater = ({ center }: { center: [number, number] }) => {
  const map = useMap();
  useEffect(() => {
    if (center[0] !== 0 || center[1] !== 0) {
      map.setView(center, map.getZoom());
    }
  }, [center, map]);
  return null;
};

const NoiseHeatmap = ({ data, userLocation }: { data: NoiseMeasurement[], userLocation: { lat: number, lng: number } | null }) => {
  const [selectedPoint, setSelectedPoint] = useState<NoiseMeasurement | null>(null);

  const center = useMemo(() => {
    if (userLocation) return [userLocation.lat, userLocation.lng] as [number, number];
    if (data.length === 0) return [0, 0] as [number, number];
    const lat = data.reduce((acc, d) => acc + d.lat, 0) / data.length;
    const lng = data.reduce((acc, d) => acc + d.lng, 0) / data.length;
    return [lat, lng] as [number, number];
  }, [data, userLocation]);

  if (data.length === 0 && !userLocation) {
    return (
      <div className="w-full h-full min-h-[400px] bg-slate-100/50 rounded-xl border border-slate-200 flex items-center justify-center text-slate-400 font-mono text-sm">
        NO DATA COLLECTED
      </div>
    );
  }

  return (
    <div className="w-full h-full min-h-[400px] bg-slate-100/50 rounded-xl border border-slate-200 relative overflow-hidden z-0">
      <MapContainer 
        center={center} 
        zoom={15} 
        style={{ height: '100%', width: '100%' }}
        scrollWheelZoom={true}
        className="z-0"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapUpdater center={center} />
        {data.map((d, i) => (
          <Circle
            key={d.id || i}
            center={[d.lat, d.lng]}
            radius={30}
            pathOptions={{
              fillColor: getNoiseColor(d.db),
              color: getNoiseColor(d.db),
              fillOpacity: 0.5,
              weight: 1,
              stroke: true
            }}
            eventHandlers={{
              click: () => setSelectedPoint(d)
            }}
          >
            <Popup>
              <div className="font-mono text-[10px]">
                <div className="font-bold text-slate-900 mb-1 text-lg">{d.db} dB</div>
                <div className="text-orange-500 uppercase tracking-widest font-bold">{d.category || 'Other'}</div>
                <div className="text-slate-400 mt-1">{new Date(d.timestamp).toLocaleString()}</div>
              </div>
            </Popup>
          </Circle>
        ))}
      </MapContainer>
      
      {/* Detail Overlay */}
      <AnimatePresence>
        {selectedPoint && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 10 }}
            className="absolute top-4 right-4 w-64 bg-white/90 border border-orange-500/30 rounded-xl p-4 shadow-2xl backdrop-blur-md z-[1000]"
          >
            <div className="flex items-center justify-between mb-3 border-b border-slate-100 pb-2">
              <span className="text-[10px] font-mono text-orange-500 uppercase tracking-widest">Measurement Detail</span>
              <button onClick={() => setSelectedPoint(null)} className="text-slate-400 hover:text-slate-900">×</button>
            </div>
            <div className="space-y-3">
              <div>
                <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mb-1">Noise Level</div>
                <div className="text-2xl font-mono font-bold text-slate-900">{selectedPoint.db} dB</div>
              </div>
              <div>
                <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mb-1">Category</div>
                <div className="text-xs font-mono text-orange-500 uppercase tracking-widest">{selectedPoint.category || 'Other'}</div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mb-1">Latitude</div>
                  <div className="text-xs font-mono text-slate-500">{selectedPoint.lat.toFixed(6)}</div>
                </div>
                <div>
                  <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mb-1">Longitude</div>
                  <div className="text-xs font-mono text-slate-500">{selectedPoint.lng.toFixed(6)}</div>
                </div>
              </div>
              <div>
                <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mb-1">Timestamp</div>
                <div className="text-xs font-mono text-slate-500">
                  {new Date(selectedPoint.timestamp).toLocaleString()}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      
      {/* Zoom Hint */}
      <div className="absolute bottom-4 right-4 text-[8px] font-mono text-slate-400 uppercase tracking-widest pointer-events-none z-[1000]">
        Scroll to zoom • Drag to pan • Click point for details
      </div>
    </div>
  );
};

const NoiseMapper = () => {
  const [localUserId, setLocalUserId] = useState<string>('');
  const [measurements, setMeasurements] = useState<NoiseMeasurement[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [currentDb, setCurrentDb] = useState(0);
  const [frequencyData, setFrequencyData] = useState<Uint8Array>(new Uint8Array(0));
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('House');
  const [isCategoryDropdownOpen, setIsCategoryDropdownOpen] = useState(false);

  const categories = ['House', 'Market', 'Park', 'Road', 'Residential Apartment', 'Office', 'Other'];

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // --- Local User ID & Data ---
  useEffect(() => {
    let id = localStorage.getItem('noise_mapper_uid');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('noise_mapper_uid', id);
    }
    setLocalUserId(id);
  }, []);

  useEffect(() => {
    const q = query(collection(db, 'noise_measurements'), orderBy('timestamp', 'desc'), limit(100));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as NoiseMeasurement));
      setMeasurements(data);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'noise_measurements');
    });

    return () => unsubscribe();
  }, []);

  // --- Geolocation ---
  useEffect(() => {
    if ("geolocation" in navigator) {
      const watchId = navigator.geolocation.watchPosition(
        (pos) => {
          setLocation({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude
          });
        },
        (err) => console.error("Geolocation error:", err),
        { enableHighAccuracy: true }
      );
      return () => navigator.geolocation.clearWatch(watchId);
    }
  }, []);

  // --- Audio Recording ---
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyserRef.current = analyser;

      setIsRecording(true);
      updateNoiseLevel();
    } catch (err) {
      console.error("Microphone access denied:", err);
    }
  };

  const stopRecording = () => {
    setIsRecording(false);
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
    if (audioContextRef.current) audioContextRef.current.close();
    setCurrentDb(0);
  };

  const updateNoiseLevel = () => {
    if (!analyserRef.current) return;

    const bufferLength = analyserRef.current.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyserRef.current.getByteFrequencyData(dataArray);
    
    setFrequencyData(new Uint8Array(dataArray));

    const sum = dataArray.reduce((acc, val) => acc + val, 0);
    const average = sum / dataArray.length;
    
    // Simple conversion to dB (approximate)
    const db = average > 0 ? 20 * Math.log10(average) + 30 : 0;
    setCurrentDb(db);

    animationFrameRef.current = requestAnimationFrame(updateNoiseLevel);
  };

  const saveMeasurement = async () => {
    if (!location || currentDb < 30) return;

    try {
      setIsUploading(true);
      await addDoc(collection(db, 'noise_measurements'), {
        uid: localUserId,
        db: Math.round(currentDb * 10) / 10,
        lat: location.lat,
        lng: location.lng,
        category: selectedCategory,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'noise_measurements');
    } finally {
      setIsUploading(false);
    }
  };

  // --- CSV Handling ---
  const downloadCSV = () => {
    const dataToExport = measurements.map((m) => {
      const dateObj = m.timestamp && (m.timestamp as any).seconds 
        ? new Date((m.timestamp as any).seconds * 1000) 
        : new Date(m.timestamp);
      
      return {
        'Latitude': m.lat,
        'Longitude': m.lng,
        'Sound Level': m.db,
        'Category': m.category || 'Other',
        'Date': dateObj.toLocaleDateString(),
        'Time': dateObj.toLocaleTimeString()
      };
    });
    const csv = Papa.unparse(dataToExport);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `noise_data_${new Date().toISOString()}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const onDrop = async (acceptedFiles: File[]) => {
    if (!location) return;
    
    const file = acceptedFiles[0];
    Papa.parse(file, {
      header: true,
      dynamicTyping: true,
      complete: async (results) => {
        setIsUploading(true);
        try {
          for (const row of results.data as any[]) {
            const dbVal = row['Sound Level'] || row.db;
            const latVal = row['Latitude'] || row.lat;
            const lngVal = row['Longitude'] || row.lng;
            const categoryVal = row['Category'] || row.category || 'Other';
            const dateVal = row['Date'];
            const timeVal = row['Time'];
            
            let timestampVal = row.timestamp || new Date().toISOString();
            if (dateVal && timeVal) {
              const combined = new Date(`${dateVal} ${timeVal}`);
              if (!isNaN(combined.getTime())) {
                timestampVal = combined.toISOString();
              }
            }

            if (dbVal && latVal && lngVal) {
              await addDoc(collection(db, 'noise_measurements'), {
                uid: localUserId,
                db: dbVal,
                lat: latVal,
                lng: lngVal,
                category: categoryVal,
                timestamp: timestampVal
              });
            }
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, 'noise_measurements');
        } finally {
          setIsUploading(false);
        }
      }
    });
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ 
    onDrop,
    accept: { 'text/csv': ['.csv'] },
    multiple: false
  } as any);

  const deleteMeasurement = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'noise_measurements', id));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `noise_measurements/${id}`);
    }
  };

  const handleDeleteAccount = async () => {
    const confirmDelete = window.confirm(
      "Are you absolutely sure? This will permanently delete ALL your noise measurements recorded from this device. This action cannot be undone."
    );
    if (!confirmDelete) return;

    try {
      // 1. Delete all noise measurements
      const q = query(collection(db, 'noise_measurements'), where('uid', '==', localUserId));
      const querySnapshot = await getDocs(q);
      const batch = writeBatch(db);
      querySnapshot.forEach((doc) => {
        batch.delete(doc.ref);
      });
      await batch.commit();
      
      alert("Data deleted successfully.");
      window.location.reload();
    } catch (error: any) {
      console.error("Error deleting data:", error);
      alert("Failed to delete data. Please try again later.");
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-orange-500/30 relative overflow-x-hidden">
      <div className="atmosphere">
        <Leaf className="nature-element float-1 top-[10%] left-[5%] w-12 h-12" />
        <Bird className="nature-element float-2 top-[25%] right-[10%] w-8 h-8" />
        <Trees className="nature-element float-3 bottom-[15%] left-[10%] w-16 h-16" />
        <Flower className="nature-element float-1 bottom-[20%] right-[15%] w-10 h-10" />
        <Leaf className="nature-element float-2 top-[60%] left-[20%] w-6 h-6" />
        <Bird className="nature-element float-3 top-[40%] left-[80%] w-10 h-10" />
      </div>
      
      {/* Header */}
      <header className="glass-panel sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Activity className="w-6 h-6 text-orange-500" />
            <div className="flex flex-col">
              <span className="font-bold tracking-tight text-lg uppercase leading-none">Noise Mapper</span>
              <span className="text-[10px] text-slate-400 font-mono uppercase tracking-widest mt-1">App created by Aritra Pal</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setIsProfileOpen(true)}
              className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-500 hover:text-slate-900"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Local Settings Modal */}
      <AnimatePresence>
        {isProfileOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsProfileOpen(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <UserCircle className="w-5 h-5 text-orange-500" />
                  <h2 className="font-bold uppercase tracking-widest text-sm">Local Settings</h2>
                </div>
                <button 
                  onClick={() => setIsProfileOpen(false)}
                  className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-500 hover:text-slate-900"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-8 space-y-8">
                {/* User Info */}
                <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-xl border border-slate-100">
                  <div className="w-12 h-12 rounded-full bg-orange-500/20 flex items-center justify-center">
                    <UserCircle className="w-6 h-6 text-orange-500" />
                  </div>
                  <div>
                    <div className="text-sm font-bold">Local Operator</div>
                    <div className="text-xs text-slate-400 flex items-center gap-1">
                      ID: {localUserId.slice(0, 8)}...
                    </div>
                  </div>
                </div>

                {/* Danger Zone */}
                <div className="pt-6 border-t border-slate-100">
                  <div className="mb-4">
                    <h3 className="text-xs font-bold text-red-500 uppercase tracking-widest mb-1">Danger Zone</h3>
                    <p className="text-[10px] text-slate-400">Permanently delete all noise data recorded from this device.</p>
                  </div>
                  <button 
                    onClick={handleDeleteAccount}
                    className="w-full py-3 border border-red-500/30 hover:bg-red-500/10 text-red-500 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    Clear Local Data
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 relative z-10">
        {/* Left Column: Controls & Real-time */}
        <div className="lg:col-span-4 space-y-6">
          {/* Recording Widget */}
          <div className="glass-card p-6 relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-orange-500/5 to-purple-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            
            <div className="relative z-10">
              <div className="mb-6">
              <h3 className="text-[10px] font-mono text-orange-500 uppercase tracking-widest mb-2">Objective</h3>
              <p className="text-xs text-slate-500 leading-relaxed">
                Map urban noise levels using phone-based measurements to identify pollution hotspots and inform urban planning.
              </p>
            </div>

            <div className="flex items-center justify-between mb-8 border-t border-slate-100 pt-4">
              <div className="flex flex-col">
                <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mb-1">Status</span>
                <div className="flex items-center gap-2">
                  <div className={cn("w-2 h-2 rounded-full", isRecording ? "bg-red-500 animate-pulse" : "bg-slate-300")} />
                  <span className="text-sm font-mono uppercase tracking-wider">
                    {isRecording ? "Capturing" : "Standby"}
                  </span>
                </div>
              </div>
              <div className="text-right">
                <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mb-1">Location</span>
                <div className="text-sm font-mono text-orange-500">
                  {location ? `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}` : "Acquiring..."}
                </div>
              </div>
            </div>

            <div className="flex flex-col items-center justify-center py-10">
              <div className="relative mb-6">
                <div className={cn(
                  "absolute inset-0 rounded-full bg-orange-500/20 blur-2xl transition-all duration-500",
                  isRecording ? "scale-150 opacity-100" : "scale-0 opacity-0"
                )} />
                <button 
                  onClick={isRecording ? stopRecording : startRecording}
                  className={cn(
                    "relative w-24 h-24 rounded-full flex items-center justify-center transition-all duration-300 shadow-2xl",
                    isRecording 
                      ? "bg-red-500 hover:bg-red-600 scale-110" 
                      : "bg-white border border-slate-200 hover:border-orange-500/50"
                  )}
                >
                  {isRecording ? <MicOff className="w-8 h-8" /> : <Mic className="w-8 h-8 text-orange-500" />}
                </button>
              </div>
              
              <div className="text-center">
                <div className="text-6xl font-mono font-bold tracking-tighter mb-1">
                  {currentDb.toFixed(1)}
                </div>
                <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Decibels (dB)</div>
                
                {/* Visual Meter Bar */}
                <div className="mt-4 w-48 h-1 bg-slate-100 rounded-full overflow-hidden mx-auto">
                  <motion.div 
                    className="h-full transition-colors duration-300"
                    style={{ backgroundColor: getNoiseColor(currentDb) }}
                    animate={{ width: `${Math.min(100, (currentDb / 140) * 100)}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Frequency Spectrum Section */}
            <div className="mt-6 pt-6 border-t border-slate-100">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Frequency Spectrum</h3>
                <span className="text-[10px] font-mono text-orange-500">20Hz - 20kHz</span>
              </div>
              <FrequencySpectrum data={frequencyData} />
            </div>

            {/* Category Selection */}
            <div className="mt-6 pt-6 border-t border-slate-100 relative">
              <h3 className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mb-4">Place Category</h3>
              <button
                onClick={() => setIsCategoryDropdownOpen(!isCategoryDropdownOpen)}
                className={cn(
                  "w-full px-4 py-3 bg-slate-50 border rounded-xl flex items-center justify-between transition-all group",
                  isCategoryDropdownOpen ? "border-orange-500/50" : "border-slate-200 hover:border-slate-300"
                )}
              >
                <span className="text-xs font-mono uppercase tracking-widest text-slate-600 group-hover:text-slate-900">
                  {selectedCategory}
                </span>
                <ChevronDown className={cn("w-4 h-4 text-slate-400 transition-transform duration-300", isCategoryDropdownOpen && "rotate-180")} />
              </button>

              <AnimatePresence>
                {isCategoryDropdownOpen && (
                  <>
                    <div 
                      className="fixed inset-0 z-40" 
                      onClick={() => setIsCategoryDropdownOpen(false)} 
                    />
                    <motion.div
                      initial={{ opacity: 0, y: -10, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -10, scale: 0.95 }}
                      className="absolute left-0 right-0 bottom-full mb-2 z-50 bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden"
                    >
                      <div className="p-2 max-h-48 overflow-y-auto">
                        {categories.map((cat) => (
                          <button
                            key={cat}
                            onClick={() => {
                              setSelectedCategory(cat);
                              setIsCategoryDropdownOpen(false);
                            }}
                            className={cn(
                              "w-full px-4 py-2 rounded-lg text-left text-[10px] font-mono uppercase tracking-widest transition-all flex items-center justify-between",
                              selectedCategory === cat
                                ? "bg-orange-500/10 text-orange-500"
                                : "text-slate-400 hover:bg-slate-50 hover:text-slate-900"
                            )}
                          >
                            {cat}
                            {selectedCategory === cat && <Check className="w-3 h-3" />}
                          </button>
                        ))}
                      </div>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>

            <button 
              disabled={!isRecording || !location || isUploading}
              onClick={saveMeasurement}
              className={cn(
                "w-full py-4 rounded-xl font-bold uppercase tracking-widest text-sm transition-all mt-6",
                isRecording && location && !isUploading
                  ? "bg-orange-500 hover:bg-orange-600 text-white shadow-lg shadow-orange-500/20"
                  : "bg-slate-100 text-slate-400 cursor-not-allowed"
              )}
            >
              {isUploading ? "Transmitting..." : "Log Measurement"}
            </button>
          </div>
        </div>
      </div>

        {/* Right Column: Visualization & History */}
        <div className="lg:col-span-8 space-y-6">
          {/* Heatmap */}
          <div className="glass-card p-6 h-[500px] flex flex-col">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <MapIcon className="w-5 h-5 text-orange-500" />
                <h2 className="font-bold uppercase tracking-widest text-sm">Noise Heatmap</h2>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: getNoiseColor(0) }} />
                  <span className="text-[10px] font-mono text-slate-400">0dB</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: getNoiseColor(140) }} />
                  <span className="text-[10px] font-mono text-slate-400">140dB</span>
                </div>
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <NoiseHeatmap data={measurements} userLocation={location} />
            </div>
          </div>

          {/* Recent Logs */}
          <div className="glass-card overflow-hidden">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <h2 className="font-bold uppercase tracking-widest text-sm">Global Noise Logs</h2>
              <span className="text-[10px] font-mono text-slate-400">
                {measurements.length} Total Records
              </span>
            </div>
            <div className="max-h-[500px] overflow-y-auto custom-scrollbar">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 bg-slate-50 z-20 text-[10px] font-mono text-slate-400 uppercase tracking-widest shadow-sm">
                  <tr>
                    <th className="p-4 font-normal">Time</th>
                    <th className="p-4 font-normal">Source</th>
                    <th className="p-4 font-normal">Level</th>
                    <th className="p-4 font-normal">Category</th>
                    <th className="p-4 font-normal">Quality</th>
                    <th className="p-4 font-normal">Coordinates</th>
                    <th className="p-4 font-normal text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  <AnimatePresence mode="popLayout">
                    {measurements.map((m) => {
                      const date = m.timestamp && (m.timestamp as any).seconds 
                        ? new Date((m.timestamp as any).seconds * 1000) 
                        : new Date(m.timestamp);
                      const isOwner = m.uid === localUserId;
                      
                      return (
                        <motion.tr 
                          key={m.id}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0, x: -20 }}
                          className={cn(
                            "hover:bg-slate-50/50 transition-colors group",
                            isOwner && "bg-orange-500/[0.05]"
                          )}
                        >
                          <td className="p-4 text-xs text-slate-400 font-mono whitespace-nowrap">
                            {isNaN(date.getTime()) ? '---' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </td>
                          <td className="p-4">
                            <div className="flex items-center gap-2">
                              <div className={cn(
                                "w-1.5 h-1.5 rounded-full",
                                isOwner ? "bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.5)]" : "bg-slate-300"
                              )} title={isOwner ? "Your Recording" : "Community Recording"} />
                              <span className="text-[10px] font-mono text-slate-400 uppercase">
                                {isOwner ? "You" : `ID:${m.uid?.slice(0, 4)}`}
                              </span>
                            </div>
                          </td>
                          <td className="p-4">
                            <div className="flex items-center gap-3">
                              <div className="w-16 h-1 bg-slate-100 rounded-full overflow-hidden hidden sm:block">
                                <div 
                                  className="h-full transition-all duration-500" 
                                  style={{ 
                                    width: `${Math.min(100, ((m.db || 0) / 140) * 100)}%`,
                                    backgroundColor: getNoiseColor(m.db || 0)
                                  }}
                                />
                              </div>
                              <span className="text-sm font-mono font-bold whitespace-nowrap">{(m.db || 0).toFixed(1)} dB</span>
                            </div>
                          </td>
                          <td className="p-4">
                            <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest whitespace-nowrap">
                              {m.category || 'Other'}
                            </span>
                          </td>
                          <td className="p-4">
                            <span className={cn(
                              "text-[9px] font-mono px-2 py-0.5 rounded-full uppercase tracking-widest whitespace-nowrap",
                              (m.db || 0) > 120 ? "bg-purple-500/20 text-purple-400 border border-purple-500/20" : 
                              (m.db || 0) > 80 ? "bg-red-500/20 text-red-400 border border-red-500/20" : 
                              (m.db || 0) > 60 ? "bg-amber-500/20 text-amber-400 border border-amber-500/20" :
                              "bg-emerald-500/20 text-emerald-400 border border-emerald-500/20"
                            )}>
                              {getNoiseQuality(m.db || 0)}
                            </span>
                          </td>
                          <td className="p-4 text-[10px] text-slate-400 font-mono whitespace-nowrap">
                            {m.lat?.toFixed(4)}, {m.lng?.toFixed(4)}
                          </td>
                          <td className="p-4 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <a 
                                href={`https://www.google.com/maps/search/?api=1&query=${m.lat},${m.lng}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-2 text-slate-500 hover:text-orange-500 transition-colors flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest"
                                title="Display in Google Maps"
                              >
                                <MapPin className="w-3.5 h-3.5" />
                              </a>
                              {isOwner && (
                                <button 
                                  onClick={() => m.id && deleteMeasurement(m.id)}
                                  className="p-2 text-slate-500 hover:text-red-500 transition-colors"
                                  title="Delete Log"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </td>
                        </motion.tr>
                      );
                    })}
                  </AnimatePresence>
                </tbody>
              </table>
              {measurements.length === 0 && (
                <div className="p-20 text-center flex flex-col items-center justify-center gap-3">
                  <Activity className="w-8 h-8 text-slate-300 animate-pulse" />
                  <div className="text-slate-400 font-mono text-xs uppercase tracking-widest">
                    Waiting for sensor data...
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Data Management */}
          <div className="glass-card p-6 space-y-4">
            <h3 className="text-xs font-mono text-slate-400 uppercase tracking-widest mb-4">Data Management</h3>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <button 
                onClick={downloadCSV}
                className="flex items-center justify-between p-4 bg-slate-50 hover:bg-slate-100 rounded-xl transition-colors group border border-slate-100"
              >
                <div className="flex items-center gap-3">
                  <Download className="w-5 h-5 text-blue-500" />
                  <div className="text-left">
                    <span className="text-sm font-medium block">Download My Data</span>
                    <span className="text-[10px] text-slate-400">Save your records to your device</span>
                  </div>
                </div>
                <span className="text-[10px] font-mono text-slate-400 group-hover:text-slate-600">.csv</span>
              </button>

              <div {...getRootProps()} className={cn(
                "p-4 border-2 border-dashed rounded-xl transition-all cursor-pointer text-center flex flex-col items-center justify-center gap-2",
                isDragActive ? "border-orange-500 bg-orange-500/5" : "border-slate-200 hover:border-slate-300"
              )}>
                <input {...getInputProps()} />
                <Upload className="w-5 h-5 text-orange-500" />
                <div className="text-center">
                  <span className="text-sm font-medium block">Upload Existing Data</span>
                  <span className="text-[10px] text-slate-400">Load records from a file</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer Info */}
      <footer className="max-w-7xl mx-auto p-6 border-t border-slate-100 mt-12 flex flex-col sm:flex-row items-center justify-between gap-4 text-[10px] font-mono text-slate-400 uppercase tracking-widest">
        <div className="flex items-center gap-4">
          <span>System v1.0.4</span>
          <span>•</span>
          <span>Encrypted Transmission</span>
        </div>
        <div className="flex items-center gap-2">
          <Info className="w-3 h-3" />
          <span>Data used for urban planning research</span>
        </div>
      </footer>
    </div>
  );
};

export default function App() {
  return (
    <ErrorBoundary>
      <NoiseMapper />
    </ErrorBoundary>
  );
}
