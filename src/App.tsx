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
  deleteDoc
} from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';
import { 
  Mic, 
  MicOff, 
  Map as MapIcon, 
  Upload, 
  Download, 
  Trash2, 
  LogOut, 
  LogIn, 
  Activity,
  AlertCircle,
  Info
} from 'lucide-react';
import * as d3 from 'd3';
import Papa from 'papaparse';
import { useDropzone } from 'react-dropzone';
import { motion, AnimatePresence } from 'motion/react';

import { db, auth, signIn, logOut } from './firebase';
import { cn } from './lib/utils';
import { NoiseMeasurement, OperationType, FirestoreErrorInfo } from './types';

// --- Error Handling ---
function getNoiseColor(db: number) {
  return d3.scaleLinear<string>()
    .domain([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140])
    .range([
      "#0088CC", "#0099AA", "#00AA88", "#00CC44", "#88CC44", 
      "#AACC44", "#DDDD44", "#FFFF44", "#FFCC44", "#FF8844", 
      "#FF6644", "#FF4444", "#FF0000", "#FF0088", "#CC0088"
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
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
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
        <div className="min-h-screen flex items-center justify-center bg-[#151619] text-white p-6">
          <div className="max-w-md w-full bg-[#1c1d21] border border-red-500/30 rounded-xl p-8 text-center">
            <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold mb-2">System Error</h2>
            <p className="text-gray-400 mb-6">{errorMessage}</p>
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

const NoiseHeatmap = ({ data }: { data: NoiseMeasurement[] }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [selectedPoint, setSelectedPoint] = useState<NoiseMeasurement | null>(null);

  useEffect(() => {
    if (!svgRef.current || data.length === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;
    const margin = { top: 20, right: 20, bottom: 40, left: 40 };

    // Normalize coordinates for visualization
    const xExtent = d3.extent(data, d => d.lng) as [number, number];
    const yExtent = d3.extent(data, d => d.lat) as [number, number];

    const xScale = d3.scaleLinear()
      .domain([xExtent[0] - 0.001, xExtent[1] + 0.001])
      .range([margin.left, width - margin.right]);

    const yScale = d3.scaleLinear()
      .domain([yExtent[0] - 0.001, yExtent[1] + 0.001])
      .range([height - margin.bottom, margin.top]);

    const colorScale = (db: number) => getNoiseColor(db);

    // Create a container for zoomable content
    const g = svg.append("g");

    // Draw grid lines (static)
    const gridX = svg.append("g")
      .attr("class", "grid")
      .attr("transform", `translate(0,${height - margin.bottom})`)
      .call(d3.axisBottom(xScale).ticks(5).tickSize(-height + margin.top + margin.bottom).tickFormat(() => ""))
      .attr("stroke-opacity", 0.1)
      .attr("stroke-dasharray", "2,2");

    const gridY = svg.append("g")
      .attr("class", "grid")
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(yScale).ticks(5).tickSize(-width + margin.left + margin.right).tickFormat(() => ""))
      .attr("stroke-opacity", 0.1)
      .attr("stroke-dasharray", "2,2");

    // Draw points into the zoomable group
    const circles = g.selectAll("circle")
      .data(data)
      .enter()
      .append("circle")
      .attr("cx", d => xScale(d.lng))
      .attr("cy", d => yScale(d.lat))
      .attr("r", 8)
      .attr("fill", d => colorScale(d.db))
      .attr("opacity", 0.6)
      .attr("stroke", "#fff")
      .attr("stroke-width", 0.5)
      .attr("cursor", "pointer")
      .on("click", (event, d) => {
        event.stopPropagation();
        setSelectedPoint(d);
      });

    // Zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 20])
      .on("zoom", (event) => {
        const { transform } = event;
        g.attr("transform", transform);
        
        // Rescale axes if needed, but for a simple heatmap we can just transform the group
        // To keep circles same size during zoom:
        circles.attr("r", 8 / transform.k);
        circles.attr("stroke-width", 0.5 / transform.k);
      });

    svg.call(zoom);

    // Click on background to deselect
    svg.on("click", () => setSelectedPoint(null));

    // Add axes labels (static)
    svg.append("text")
      .attr("x", width / 2)
      .attr("y", height - 5)
      .attr("text-anchor", "middle")
      .attr("fill", "#8E9299")
      .attr("font-size", "10px")
      .attr("font-family", "monospace")
      .text("LONGITUDE");

    svg.append("text")
      .attr("transform", "rotate(-90)")
      .attr("x", -height / 2)
      .attr("y", 15)
      .attr("text-anchor", "middle")
      .attr("fill", "#8E9299")
      .attr("font-size", "10px")
      .attr("font-family", "monospace")
      .text("LATITUDE");

  }, [data]);

  return (
    <div className="w-full h-full min-h-[400px] bg-[#1a1b1e] rounded-xl border border-white/5 relative overflow-hidden">
      <svg ref={svgRef} className="w-full h-full" />
      
      {/* Detail Overlay */}
      <AnimatePresence>
        {selectedPoint && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 10 }}
            className="absolute top-4 right-4 w-64 bg-[#1c1d21] border border-orange-500/30 rounded-xl p-4 shadow-2xl backdrop-blur-md z-10"
          >
            <div className="flex items-center justify-between mb-3 border-b border-white/5 pb-2">
              <span className="text-[10px] font-mono text-orange-500 uppercase tracking-widest">Measurement Detail</span>
              <button onClick={() => setSelectedPoint(null)} className="text-gray-500 hover:text-white">×</button>
            </div>
            <div className="space-y-3">
              <div>
                <div className="text-[10px] font-mono text-gray-500 uppercase tracking-widest mb-1">Noise Level</div>
                <div className="text-2xl font-mono font-bold text-white">{selectedPoint.db} dB</div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] font-mono text-gray-500 uppercase tracking-widest mb-1">Latitude</div>
                  <div className="text-xs font-mono text-gray-300">{selectedPoint.lat.toFixed(6)}</div>
                </div>
                <div>
                  <div className="text-[10px] font-mono text-gray-500 uppercase tracking-widest mb-1">Longitude</div>
                  <div className="text-xs font-mono text-gray-300">{selectedPoint.lng.toFixed(6)}</div>
                </div>
              </div>
              <div>
                <div className="text-[10px] font-mono text-gray-500 uppercase tracking-widest mb-1">Timestamp</div>
                <div className="text-xs font-mono text-gray-300">
                  {new Date(selectedPoint.timestamp).toLocaleString()}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {data.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-500 font-mono text-sm">
          NO DATA COLLECTED
        </div>
      )}
      
      {/* Zoom Hint */}
      <div className="absolute bottom-4 right-4 text-[8px] font-mono text-gray-600 uppercase tracking-widest pointer-events-none">
        Scroll to zoom • Drag to pan • Click point for details
      </div>
    </div>
  );
};

const NoiseMapper = () => {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [measurements, setMeasurements] = useState<NoiseMeasurement[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [currentDb, setCurrentDb] = useState(0);
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // --- Auth & Data ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!isAuthReady || !user) {
      setMeasurements([]);
      return;
    }

    const q = query(collection(db, 'noise_measurements'), orderBy('timestamp', 'desc'), limit(100));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as NoiseMeasurement));
      setMeasurements(data);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'noise_measurements');
    });

    return () => unsubscribe();
  }, [isAuthReady, user]);

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
      analyser.fftSize = 256;
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

    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(dataArray);

    const sum = dataArray.reduce((acc, val) => acc + val, 0);
    const average = sum / dataArray.length;
    
    // Simple conversion to dB (approximate)
    const db = average > 0 ? 20 * Math.log10(average) + 30 : 0;
    setCurrentDb(db);

    animationFrameRef.current = requestAnimationFrame(updateNoiseLevel);
  };

  const saveMeasurement = async () => {
    if (!user || !location || currentDb < 30) return;

    try {
      setIsUploading(true);
      await addDoc(collection(db, 'noise_measurements'), {
        uid: user.uid,
        db: Math.round(currentDb * 10) / 10,
        lat: location.lat,
        lng: location.lng,
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
    const csv = Papa.unparse(measurements.map(({ id, uid, ...rest }) => rest));
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
    if (!user || !location) return;
    
    const file = acceptedFiles[0];
    Papa.parse(file, {
      header: true,
      dynamicTyping: true,
      complete: async (results) => {
        setIsUploading(true);
        try {
          for (const row of results.data as any[]) {
            if (row.db && row.lat && row.lng) {
              await addDoc(collection(db, 'noise_measurements'), {
                uid: user.uid,
                db: row.db,
                lat: row.lat,
                lng: row.lng,
                timestamp: row.timestamp || new Date().toISOString()
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

  if (!isAuthReady) return null;

  if (!user) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-6 font-sans">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full bg-[#151619] border border-white/5 rounded-2xl p-10 text-center shadow-2xl"
        >
          <div className="w-16 h-16 bg-orange-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
            <Activity className="w-8 h-8 text-orange-500" />
          </div>
          <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">Urban Noise Mapper</h1>
          <p className="text-gray-400 mb-8 leading-relaxed">
            Help us map noise pollution in your city. Record, tag, and visualize sound levels in real-time.
          </p>
          <button 
            onClick={signIn}
            className="w-full py-4 bg-orange-500 hover:bg-orange-600 text-white font-bold rounded-xl transition-all flex items-center justify-center gap-3 shadow-lg shadow-orange-500/20"
          >
            <LogIn className="w-5 h-5" />
            Sign in with Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-orange-500/30">
      {/* Header */}
      <header className="border-b border-white/5 bg-[#151619]/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Activity className="w-6 h-6 text-orange-500" />
            <span className="font-bold tracking-tight text-lg uppercase">Noise Mapper</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden sm:flex flex-col items-end">
              <span className="text-xs text-gray-400 font-mono uppercase tracking-widest">Operator</span>
              <span className="text-sm font-medium">{user.displayName}</span>
            </div>
            <button 
              onClick={logOut}
              className="p-2 hover:bg-white/5 rounded-lg transition-colors text-gray-400 hover:text-white"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Controls & Real-time */}
        <div className="lg:col-span-4 space-y-6">
          {/* Recording Widget */}
          <div className="bg-[#151619] border border-white/5 rounded-2xl p-6 shadow-xl relative overflow-hidden">
            <div className="mb-6">
              <h3 className="text-[10px] font-mono text-orange-500 uppercase tracking-widest mb-2">Objective</h3>
              <p className="text-xs text-gray-400 leading-relaxed">
                Map urban noise levels using phone-based measurements to identify pollution hotspots and inform urban planning.
              </p>
            </div>

            <div className="flex items-center justify-between mb-8 border-t border-white/5 pt-4">
              <div className="flex flex-col">
                <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest mb-1">Status</span>
                <div className="flex items-center gap-2">
                  <div className={cn("w-2 h-2 rounded-full", isRecording ? "bg-red-500 animate-pulse" : "bg-gray-600")} />
                  <span className="text-sm font-mono uppercase tracking-wider">
                    {isRecording ? "Capturing" : "Standby"}
                  </span>
                </div>
              </div>
              <div className="text-right">
                <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest mb-1">Location</span>
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
                      : "bg-[#1c1d21] border border-white/10 hover:border-orange-500/50"
                  )}
                >
                  {isRecording ? <MicOff className="w-8 h-8" /> : <Mic className="w-8 h-8 text-orange-500" />}
                </button>
              </div>
              
              <div className="text-center">
                <div className="text-6xl font-mono font-bold tracking-tighter mb-1">
                  {currentDb.toFixed(1)}
                </div>
                <div className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">Decibels (dB)</div>
                
                {/* Visual Meter Bar */}
                <div className="mt-4 w-48 h-1 bg-white/5 rounded-full overflow-hidden mx-auto">
                  <motion.div 
                    className="h-full transition-colors duration-300"
                    style={{ backgroundColor: getNoiseColor(currentDb) }}
                    animate={{ width: `${Math.min(100, (currentDb / 140) * 100)}%` }}
                  />
                </div>
              </div>
            </div>

            <button 
              disabled={!isRecording || !location || isUploading}
              onClick={saveMeasurement}
              className={cn(
                "w-full py-4 rounded-xl font-bold uppercase tracking-widest text-sm transition-all mt-6",
                isRecording && location && !isUploading
                  ? "bg-orange-500 hover:bg-orange-600 text-white shadow-lg shadow-orange-500/20"
                  : "bg-white/5 text-gray-600 cursor-not-allowed"
              )}
            >
              {isUploading ? "Transmitting..." : "Log Measurement"}
            </button>
          </div>

          {/* Data Management */}
          <div className="bg-[#151619] border border-white/5 rounded-2xl p-6 space-y-4">
            <h3 className="text-xs font-mono text-gray-500 uppercase tracking-widest mb-4">Data Management</h3>
            
            <button 
              onClick={downloadCSV}
              className="w-full flex items-center justify-between p-4 bg-white/5 hover:bg-white/10 rounded-xl transition-colors group"
            >
              <div className="flex items-center gap-3">
                <Download className="w-5 h-5 text-blue-400" />
                <span className="text-sm font-medium">Export CSV</span>
              </div>
              <span className="text-[10px] font-mono text-gray-500 group-hover:text-gray-300">.csv</span>
            </button>

            <div {...getRootProps()} className={cn(
              "w-full p-4 border-2 border-dashed rounded-xl transition-all cursor-pointer text-center",
              isDragActive ? "border-orange-500 bg-orange-500/5" : "border-white/10 hover:border-white/20"
            )}>
              <input {...getInputProps()} />
              <div className="flex flex-col items-center gap-2">
                <Upload className="w-5 h-5 text-orange-500" />
                <span className="text-sm font-medium">Import CSV</span>
                <span className="text-[10px] text-gray-500">Drop or click to upload</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Visualization & History */}
        <div className="lg:col-span-8 space-y-6">
          {/* Heatmap */}
          <div className="bg-[#151619] border border-white/5 rounded-2xl p-6 shadow-xl h-[500px] flex flex-col">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <MapIcon className="w-5 h-5 text-orange-500" />
                <h2 className="font-bold uppercase tracking-widest text-sm">Noise Heatmap</h2>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: getNoiseColor(0) }} />
                  <span className="text-[10px] font-mono text-gray-500">0dB</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: getNoiseColor(140) }} />
                  <span className="text-[10px] font-mono text-gray-500">140dB</span>
                </div>
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <NoiseHeatmap data={measurements} />
            </div>
          </div>

          {/* Recent Logs */}
          <div className="bg-[#151619] border border-white/5 rounded-2xl overflow-hidden shadow-xl">
            <div className="p-6 border-b border-white/5 flex items-center justify-between">
              <h2 className="font-bold uppercase tracking-widest text-sm">My Recent Logs</h2>
              <span className="text-[10px] font-mono text-gray-500">
                {measurements.filter(m => m.uid === user.uid).length} Records
              </span>
            </div>
            <div className="max-h-[400px] overflow-y-auto">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 bg-[#1c1d21] text-[10px] font-mono text-gray-500 uppercase tracking-widest">
                  <tr>
                    <th className="p-4 font-normal">Time</th>
                    <th className="p-4 font-normal">Level</th>
                    <th className="p-4 font-normal">Quality</th>
                    <th className="p-4 font-normal">Coordinates</th>
                    <th className="p-4 font-normal text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  <AnimatePresence mode="popLayout">
                    {measurements.filter(m => m.uid === user.uid).map((m) => (
                      <motion.tr 
                        key={m.id}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0, x: -20 }}
                        className="hover:bg-white/[0.02] transition-colors group"
                      >
                        <td className="p-4 text-xs text-gray-400 font-mono">
                          {new Date(m.timestamp).toLocaleTimeString()}
                        </td>
                        <td className="p-4">
                          <div className="flex items-center gap-2">
                            <div className="w-12 h-1.5 bg-white/5 rounded-full overflow-hidden">
                              <div 
                                className="h-full bg-orange-500" 
                                style={{ width: `${Math.min(100, (m.db / 140) * 100)}%` }}
                              />
                            </div>
                            <span className="text-sm font-mono font-bold">{m.db} dB</span>
                          </div>
                        </td>
                        <td className="p-4">
                          <span className={cn(
                            "text-[10px] font-mono px-2 py-0.5 rounded-full uppercase tracking-widest",
                            m.db > 120 ? "bg-red-500/20 text-red-400" : 
                            m.db > 80 ? "bg-orange-500/20 text-orange-400" : 
                            "bg-green-500/20 text-green-400"
                          )}>
                            {getNoiseQuality(m.db)}
                          </span>
                        </td>
                        <td className="p-4 text-xs text-gray-500 font-mono">
                          {m.lat.toFixed(4)}, {m.lng.toFixed(4)}
                        </td>
                        <td className="p-4 text-right">
                          <button 
                            onClick={() => m.id && deleteMeasurement(m.id)}
                            className="p-2 text-gray-600 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </motion.tr>
                    ))}
                  </AnimatePresence>
                </tbody>
              </table>
              {measurements.filter(m => m.uid === user.uid).length === 0 && (
                <div className="p-10 text-center text-gray-500 font-mono text-sm">
                  NO PERSONAL RECORDS FOUND
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Footer Info */}
      <footer className="max-w-7xl mx-auto p-6 border-t border-white/5 mt-12 flex flex-col sm:flex-row items-center justify-between gap-4 text-[10px] font-mono text-gray-600 uppercase tracking-widest">
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
