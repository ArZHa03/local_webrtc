/**
 * Zoom Lite Offline - Main Application
 * WebRTC video conferencing with host recording
 * v2.0 - Fixed recording, screen share layout, and UI improvements
 */

// ============================================
// Configuration
// ============================================

const CONFIG = {
    // ICE servers - empty for local network (no STUN/TURN needed)
    iceServers: [],
    // Media constraints - Lowered resolution for better local network performance (Efficiency)
    mediaConstraints: {
        video: {
            width: { ideal: 640, max: 1280 },
            height: { ideal: 480, max: 720 },
            frameRate: { ideal: 24, max: 30 },
            facingMode: 'user'
        },
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        }
    },
    // Screen share constraints - Added frameRate limit to save bandwidth/CPU
    screenConstraints: {
        video: {
            cursor: 'always',
            displaySurface: 'monitor',
            frameRate: { ideal: 10, max: 15 } // Presentations don't need 30fps
        },
        audio: true
    },
    // Max bitrates in kbps (Efficiency)
    maxBitrates: {
        camera: 1000,   // 1 Mbps
        screen: 2000    // 2 Mbps
    },
    // Recording settings - high efficiency codecs preferred
    recordingMimeTypes: [
        'video/mp4;codecs=hvc1,opus', // H.265 in MP4 (Safari/Chrome experimental)
        'video/webm;codecs=hevc,opus', // H.265 in WebM
        'video/webm;codecs=vp9,opus',  // VP9 (Very efficient, standard in Chrome)
        'video/webm;codecs=vp8,opus',  // VP8 (Standard, less efficient)
        'video/webm'
    ]
};

// ============================================
// State Management
// ============================================

const state = {
    // WebSocket connection
    ws: null,

    // User info
    participantId: null,
    roomId: null,
    name: '',
    isHost: false,

    // Media streams
    localStream: null,
    screenStream: null,

    // Peer connections
    peers: new Map(), // participantId -> { pc, stream, name, isHost, screenSender, cameraSender }

    // UI state
    isMicOn: true,
    isCameraOn: true,
    isScreenSharing: false,
    isRecording: false,
    isRecordingPaused: false,

    // Recording
    mediaRecorder: null,
    recordedChunks: [],
    recordingCanvas: null,
    recordingCtx: null,
    recordingAnimationId: null,
    audioContext: null,
    recordingStartTime: null,
    totalPausedTime: 0,
    lastPauseStartTime: null,

    // Screen Share State
    screenSharerId: null,

    // Recording Layout & Filtering
    pinnedParticipantId: null,
    hideInactive: false,
    audioAnalyzers: new Map(), // participantId -> { analyser, dataArray }
    speakingParticipants: new Set(), // participants currently talking

    // Reconnection
    isReconnecting: false,
    reconnectAttempts: 0,
    maxReconnectAttempts: 10
};

// ============================================
// DOM Elements
// ============================================

const elements = {
    // Screens
    lobby: document.getElementById('lobby'),
    meeting: document.getElementById('meeting'),

    // Lobby
    nameInput: document.getElementById('nameInput'),
    roomInput: document.getElementById('roomInput'),
    createBtn: document.getElementById('createBtn'),
    joinBtn: document.getElementById('joinBtn'),

    // Meeting header
    roomIdDisplay: document.getElementById('roomIdDisplay'),
    copyRoomBtn: document.getElementById('copyRoomBtn'),
    recordingIndicator: document.getElementById('recordingIndicator'),
    recordingTime: document.getElementById('recordingTime'),
    participantCount: document.getElementById('participantCount'),

    // Video
    videoGrid: document.getElementById('videoGrid'),
    localVideoContainer: document.getElementById('localVideoContainer'),
    localVideo: document.getElementById('localVideo'),
    localName: document.getElementById('localName'),
    localMicStatus: document.getElementById('localMicStatus'),

    // Screen share layout
    screenShareLayout: document.getElementById('screenShareLayout'),
    screenShareMain: document.getElementById('screenShareMain'),
    screenShareSidebar: document.getElementById('screenShareSidebar'),
    pipVideo: document.getElementById('pipVideo'),

    // Controls
    micBtn: document.getElementById('micBtn'),
    cameraBtn: document.getElementById('cameraBtn'),
    screenBtn: document.getElementById('screenBtn'),
    recordBtn: document.getElementById('recordBtn'),
    hideInactiveBtn: document.getElementById('hideInactiveBtn'),
    pauseRecordBtn: document.getElementById('pauseRecordBtn'),
    stopRecordBtn: document.getElementById('stopRecordBtn'),
    leaveBtn: document.getElementById('leaveBtn'),

    // Toast
    toastContainer: document.getElementById('toastContainer')
};

// ============================================
// Utility Functions
// ============================================

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
        success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };

    toast.innerHTML = `
    <span class="toast-icon">${icons[type]}</span>
    <span class="toast-message">${message}</span>
  `;

    elements.toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function updateParticipantCount() {
    elements.participantCount.textContent = state.peers.size + 1;
}

function updateVideoGridLayout() {
    const count = state.peers.size + 1;
    elements.videoGrid.setAttribute('data-count', Math.min(count, 4));
}

function getInitials(name) {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function updateRecordingTime() {
    if (state.isRecording && !state.isRecordingPaused && state.recordingStartTime) {
        // Calculate elapsed time minus paused duration
        const now = Date.now();
        const totalElapsed = now - state.recordingStartTime;
        const netElapsed = totalElapsed - state.totalPausedTime;

        // Prevent negative time
        const elapsedSeconds = Math.max(0, netElapsed / 1000);

        if (elements.recordingTime) {
            elements.recordingTime.textContent = formatTime(elapsedSeconds);
        }
    }
}

// ============================================
// WebSocket Connection
// ============================================

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    state.ws = new WebSocket(wsUrl);

    // Clear existing ping interval if any
    if (state.pingInterval) clearInterval(state.pingInterval);

    state.ws.onopen = () => {
        console.log('WebSocket connected');
        if (state.isReconnecting) {
            // Re-join the room
            sendSignaling({
                type: 'join-room',
                roomId: state.roomId,
                name: state.name,
                rejoinId: state.participantId
            });
        }

        // Start heartbeat
        state.pingInterval = setInterval(() => {
            if (state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({ type: 'ping' }));
            }
        }, 15000); // 15 seconds
    };

    state.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleSignalingMessage(data);
    };

    state.ws.onclose = () => {
        console.log('WebSocket disconnected');
        if (state.pingInterval) clearInterval(state.pingInterval);
        if (state.roomId) {
            state.isReconnecting = true;
            showToast('Connection lost. Reconnecting...', 'error');

            // Attempt to reconnect after a delay
            if (state.reconnectAttempts < state.maxReconnectAttempts) {
                setTimeout(() => {
                    state.reconnectAttempts++;
                    connectWebSocket();
                }, 2000);
            } else {
                showToast('Could not reconnect', 'error');
                leaveMeeting();
            }
        }
    };

    state.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
}

function sendSignaling(data) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(data));
    }
}

// ============================================
// Signaling Message Handlers
// ============================================

async function handleSignalingMessage(data) {
    switch (data.type) {
        case 'room-created':
            state.roomId = data.roomId;
            state.participantId = data.participantId;
            state.isHost = true;
            enterMeeting();
            showToast(`Meeting created: ${data.roomId}`, 'success');
            break;

        case 'room-joined':
            state.roomId = data.roomId;
            state.participantId = data.participantId;
            state.isHost = false;
            enterMeeting();

            // Connect to existing participants
            for (const participant of data.participants) {
                await createPeerConnection(participant.id, participant.name, participant.isHost, true);
            }
            showToast(`Joined meeting: ${data.roomId}`, 'success');
            break;

        case 'participant-joined':
            await createPeerConnection(data.participant.id, data.participant.name, data.participant.isHost, false);
            showToast(`${data.participant.name} joined`, 'info');
            break;

        case 'participant-left':
            removePeer(data.participantId);
            break;

        case 'offer':
            await handleOffer(data);
            break;

        case 'answer':
            await handleAnswer(data);
            break;

        case 'ice-candidate':
            await handleIceCandidate(data);
            break;

        case 'media-state-changed':
            updateRemoteMediaState(data.participantId, data.mediaType, data.enabled);
            break;

        case 'start-screen-share':
            state.screenSharerId = data.participantId;
            // Store the stream ID for track identification (Efficiency/Correctness)
            const peer = state.peers.get(data.participantId);
            if (peer) peer.screenStreamId = data.streamId;
            updateScreenShareLayout();
            showToast(`${peer ? peer.name : data.participantId} started screen sharing`, 'info');
            break;

        case 'stop-screen-share':
            state.screenSharerId = null;
            updateScreenShareLayout();
            showToast('Screen sharing stopped', 'info');
            break;

        case 'recording-started':
            showToast('Host started recording', 'info');
            elements.recordingIndicator.classList.remove('hidden');
            break;

        case 'recording-stopped':
            showToast('Host stopped recording', 'info');
            elements.recordingIndicator.classList.add('hidden');
            break;

        case 'room-closed':
            showToast('Host ended the meeting', 'error');
            leaveMeeting();
            break;

        case 'reconnected':
            state.isReconnecting = false;
            state.reconnectAttempts = 0;
            showToast('Reconnected to meeting!', 'success');
            break;

        case 'participant-reconnected':
            showToast(`${state.peers.get(data.participantId)?.name || 'Participant'} back online`, 'info');
            // Re-negotiate if connection is failed
            const pData = state.peers.get(data.participantId);
            if (pData && (pData.pc.iceConnectionState === 'failed' || pData.pc.iceConnectionState === 'disconnected')) {
                console.log('Pushing renegotiation for reconnected participant');
                pData.pc.restartIce();
            }
            break;

        case 'error':
            showToast(data.message, 'error');
            if (data.message === 'Room not found') leaveMeeting();
            break;
    }
}

// ============================================
// WebRTC Peer Connection
// ============================================

async function createPeerConnection(peerId, peerName, isHost, initiator) {
    console.log(`Creating peer connection to ${peerId} (initiator: ${initiator})`);

    const pc = new RTCPeerConnection({ iceServers: CONFIG.iceServers });

    const peerData = {
        pc,
        stream: new MediaStream(),
        name: peerName,
        isHost,
        videoElement: null,
        isMicOn: true,
        isCameraOn: true,
        screenStream: null,
        screenSender: null,
        cameraSenders: []
    };

    state.peers.set(peerId, peerData);

    // Add local tracks to connection
    if (state.localStream) {
        state.localStream.getTracks().forEach(track => {
            const sender = pc.addTrack(track, state.localStream);
            peerData.cameraSenders.push(sender);
        });
    }

    // Handle incoming tracks
    pc.ontrack = (event) => {
        console.log(`Received track from ${peerId}:`, event.track.kind, 'Stream ID:', event.streams[0]?.id);

        // Logic to distinguish camera vs screen share based on Stream ID
        // This is more robust than counting tracks
        const stream = event.streams[0];
        const isScreenShare = stream && state.peers.get(peerId)?.screenStreamId === stream.id ||
            (stream && stream.getVideoTracks().length > 0 && peerData.stream.getVideoTracks().length > 0 && event.track.kind === 'video');

        if (event.track.kind === 'video' && isScreenShare) {
            console.log(`Received screen share track from ${peerId}`);
            if (!peerData.screenStream) {
                peerData.screenStream = stream;
            }
            // If this peer is the current screen sharer, update the main view immediately
            if (state.screenSharerId === peerId) {
                elements.screenShareMain.srcObject = peerData.screenStream;
            }
        } else {
            // It's a camera track or audio
            peerData.stream.addTrack(event.track);

            if (!peerData.videoElement) {
                createRemoteVideoElement(peerId, peerData);
            }

            // Initialize audio analysis if already recording
            if (state.isRecording && event.track.kind === 'audio') {
                initAudioAnalysis(peerId, peerData.stream);
            }
        }
    };

    // Handle negotiation needed
    pc.onnegotiationneeded = async () => {
        console.log(`Negotiation needed with ${peerId} (initiator: ${initiator})`);

        // Prevent glare: If we are not the initiator and haven't set a remote description yet,
        // ignore this event. The other side (initiator) will send an offer.
        if (!initiator && !pc.currentRemoteDescription) {
            console.log('Skipping negotiation (not initiator and no remote description)');
            return;
        }

        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            sendSignaling({
                type: 'offer',
                target: peerId,
                sdp: offer.sdp
            });
        } catch (e) {
            console.error('Error during renegotiation:', e);
        }
    };

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignaling({
                type: 'ice-candidate',
                target: peerId,
                candidate: event.candidate
            });
        }
    };

    // Monitor ICE connection state
    pc.oniceconnectionstatechange = () => {
        console.log(`ICE Connection state with ${peerId}: ${pc.iceConnectionState}`);

        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            updateBandwidthConstraints(pc);
        }

        if (pc.iceConnectionState === 'disconnected') {
            showToast(`Connection to ${peerName} unstable...`, 'info');
        }

        if (pc.iceConnectionState === 'failed') {
            showToast(`Connection to ${peerName} failed. Attempting to repair...`, 'error');
            pc.restartIce(); // Try to recover
        }
    };

    // If we're the initiator, create and send offer
    if (initiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        sendSignaling({
            type: 'offer',
            target: peerId,
            sdp: offer.sdp
        });
    }

    updateParticipantCount();
    updateVideoGridLayout();
}

async function handleOffer(data) {
    const peerData = state.peers.get(data.from);
    if (!peerData) {
        console.error('Received offer from unknown peer:', data.from);
        return;
    }

    const pc = peerData.pc;
    await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    sendSignaling({
        type: 'answer',
        target: data.from,
        sdp: answer.sdp
    });
}

async function handleAnswer(data) {
    const peerData = state.peers.get(data.from);
    if (!peerData) {
        console.error('Received answer from unknown peer:', data.from);
        return;
    }

    await peerData.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
}

async function handleIceCandidate(data) {
    const peerData = state.peers.get(data.from);
    if (!peerData) {
        console.error('Received ICE candidate from unknown peer:', data.from);
        return;
    }

    try {
        await peerData.pc.addIceCandidate(data.candidate);
    } catch (e) {
        console.error('Error adding ICE candidate:', e);
    }
}

/**
 * Limit bitrate to improve efficiency on local networks (hotspots/public wifi)
 */
async function updateBandwidthConstraints(pc) {
    try {
        const senders = pc.getSenders();

        for (const sender of senders) {
            if (!sender.track) continue;

            const parameters = sender.getParameters();
            if (!parameters.encodings || parameters.encodings.length === 0) {
                parameters.encodings = [{}];
            }

            if (sender.track.kind === 'video') {
                // Check if this is the screen share track or camera track
                const isScreen = state.screenStream && state.screenStream.getTracks().includes(sender.track);
                const maxBitrate = isScreen ? CONFIG.maxBitrates.screen : CONFIG.maxBitrates.camera;

                parameters.encodings[0].maxBitrate = maxBitrate * 1000; // convert to bps
                console.log(`Setting max bitrate for ${isScreen ? 'screen' : 'camera'} track to ${maxBitrate} kbps`);
            } else if (sender.track.kind === 'audio') {
                parameters.encodings[0].maxBitrate = 64000; // 64 kbps for audio
            }

            await sender.setParameters(parameters);
        }
    } catch (e) {
        console.error('Error setting bandwidth constraints:', e);
    }
}

function removePeer(peerId) {
    const peerData = state.peers.get(peerId);
    if (peerData) {
        showToast(`${peerData.name} left`, 'info');

        peerData.pc.close();

        if (peerData.videoElement) {
            peerData.videoElement.parentElement.remove();
        }

        state.peers.delete(peerId);
        updateParticipantCount();
        updateVideoGridLayout();
    }
}

// ============================================
// Remote Video Elements
// ============================================

function createRemoteVideoElement(peerId, peerData) {
    const container = document.createElement('div');
    container.className = 'video-container';
    container.id = `video-${peerId}`;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = peerData.stream;

    const label = document.createElement('div');
    label.className = 'video-label';
    label.innerHTML = `
    <span>${peerData.name}</span>
    ${peerData.isHost ? '<span class="host-badge">HOST</span>' : ''}
  `;

    const status = document.createElement('div');
    status.className = 'video-status';
    status.innerHTML = `
    <span id="mic-status-${peerId}" class="status-icon mic-on">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"></path>
        <path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"></path>
      </svg>
    </span>
    <button id="pin-${peerId}" class="pin-btn" title="Pin Participant" onclick="togglePin('${peerId}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"></path>
            <circle cx="12" cy="10" r="3"></circle>
        </svg>
    </button>
  `;

    container.appendChild(video);
    container.appendChild(label);
    container.appendChild(status);

    elements.videoGrid.appendChild(container);
    peerData.videoElement = video;
}

function updateRemoteMediaState(peerId, mediaType, enabled) {
    const peerData = state.peers.get(peerId);
    if (!peerData) return;

    if (mediaType === 'audio') {
        peerData.isMicOn = enabled;
        const micStatus = document.getElementById(`mic-status-${peerId}`);
        if (micStatus) {
            micStatus.className = `status-icon ${enabled ? 'mic-on' : 'mic-off'}`;
        }
    } else if (mediaType === 'video') {
        peerData.isCameraOn = enabled;
    }
}

/**
 * Audio Analysis for active speaker detection
 */
function initAudioAnalysis(participantId, stream) {
    if (!stream || stream.getAudioTracks().length === 0) return;

    if (!state.audioContext) {
        state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    const source = state.audioContext.createMediaStreamSource(stream);
    const analyser = state.audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    state.audioAnalyzers.set(participantId, {
        analyser,
        dataArray: new Uint8Array(analyser.frequencyBinCount)
    });
}

function updateActiveSpeakers() {
    state.audioAnalyzers.forEach((data, id) => {
        data.analyser.getByteFrequencyData(data.dataArray);
        const sum = data.dataArray.reduce((a, b) => a + b, 0);
        const average = sum / data.dataArray.length;

        if (average > 30) { // Volume threshold
            state.speakingParticipants.add(id);
        } else {
            state.speakingParticipants.delete(id);
        }
    });

    // Update UI if needed (active speaker border etc.)
    document.querySelectorAll('.video-container').forEach(container => {
        const id = container.id === 'localVideoContainer' ? 'local' : container.id.replace('remote-', '');
        container.classList.toggle('speaking', state.speakingParticipants.has(id));
    });
}

// ============================================
// Recording Layout Controls
// ============================================

function togglePin(participantId) {
    if (state.pinnedParticipantId === participantId) {
        state.pinnedParticipantId = null;
        showToast('Unpinned participant', 'info');
    } else {
        state.pinnedParticipantId = participantId;
        showToast('Pinned participant', 'success');
    }

    // Update UI buttons
    document.querySelectorAll('.pin-btn').forEach(btn => {
        const id = btn.id.replace('pin-', '');
        btn.classList.toggle('active', state.pinnedParticipantId === id);
    });
}

function toggleHideInactive() {
    state.hideInactive = !state.hideInactive;
    elements.hideInactiveBtn.classList.toggle('active', state.hideInactive);

    const label = elements.hideInactiveBtn.querySelector('span:last-child');
    if (label) {
        label.textContent = state.hideInactive ? 'Show All' : 'Hide Inactive';
    }

    showToast(state.hideInactive ? 'Hiding inactive participants from recording' : 'Showing all participants', 'info');
}

// ============================================
// Media Controls
// ============================================

async function initLocalMedia() {
    try {
        state.localStream = await navigator.mediaDevices.getUserMedia(CONFIG.mediaConstraints);
        elements.localVideo.srcObject = state.localStream;
        return true;
    } catch (error) {
        console.error('Error accessing media devices:', error);
        showToast('Cannot access camera/microphone', 'error');
        return false;
    }
}

function toggleMic() {
    if (state.localStream) {
        const audioTrack = state.localStream.getAudioTracks()[0];
        if (audioTrack) {
            state.isMicOn = !state.isMicOn;
            audioTrack.enabled = state.isMicOn;

            elements.micBtn.classList.toggle('off', !state.isMicOn);
            elements.localMicStatus.className = `status-icon ${state.isMicOn ? 'mic-on' : 'mic-off'}`;

            // Update button label
            const label = elements.micBtn.querySelector('span:last-child');
            if (label) {
                label.textContent = state.isMicOn ? 'Mic On' : 'Mic Off';
            }

            sendSignaling({
                type: 'toggle-media',
                mediaType: 'audio',
                enabled: state.isMicOn
            });
        }
    }
}

function toggleCamera() {
    if (state.localStream) {
        const videoTrack = state.localStream.getVideoTracks()[0];
        if (videoTrack) {
            state.isCameraOn = !state.isCameraOn;
            videoTrack.enabled = state.isCameraOn;

            elements.cameraBtn.classList.toggle('off', !state.isCameraOn);

            // Update button label
            const label = elements.cameraBtn.querySelector('span:last-child');
            if (label) {
                label.textContent = state.isCameraOn ? 'Cam On' : 'Cam Off';
            }

            sendSignaling({
                type: 'toggle-media',
                mediaType: 'video',
                enabled: state.isCameraOn
            });
        }
    }
}

async function toggleScreenShare() {
    if (state.isScreenSharing) {
        stopScreenShare();
    } else {
        await startScreenShare();
    }
}

async function startScreenShare() {
    try {
        state.screenStream = await navigator.mediaDevices.getDisplayMedia(CONFIG.screenConstraints);

        const screenTrack = state.screenStream.getVideoTracks()[0];

        // Add screen track to peer connections
        state.peers.forEach((peerData) => {
            // Remove old screen sender if exists (prevent accumulation)
            if (peerData.screenSender) {
                try {
                    peerData.pc.removeTrack(peerData.screenSender);
                } catch (e) { console.error(e); }
            }
            peerData.screenSender = peerData.pc.addTrack(screenTrack, state.screenStream);
        });

        // Handle screen share stop
        screenTrack.onended = () => {
            stopScreenShare();
        };

        state.isScreenSharing = true;
        elements.screenBtn.classList.add('active');

        // Update button label
        const label = elements.screenBtn.querySelector('span:last-child');
        if (label) {
            label.textContent = 'Stop Share';
        }

        // Show screen share layout with PiP
        updateScreenShareLayout();

        sendSignaling({
            type: 'start-screen-share',
            streamId: state.screenStream.id
        });
        showToast('Screen sharing started', 'success');

    } catch (error) {
        console.error('Error starting screen share:', error);
        if (error.name !== 'AbortError') {
            showToast('Cannot share screen', 'error');
        }
    }
}

/**
 * Helper to draw image on canvas with aspect ratio preservation (Contain or Cover)
 */
function drawImageAspect(ctx, img, x, y, w, h, mode = 'contain') {
    if (!img || img.readyState < 2) return;

    const imgW = img.videoWidth || img.width;
    const imgH = img.videoHeight || img.height;
    const imgRatio = imgW / imgH;
    const targetRatio = w / h;

    let renderW, renderH, renderX, renderY;

    if (mode === 'contain') {
        // Fit within the box (letterbox/pillarbox)
        if (imgRatio > targetRatio) {
            renderW = w;
            renderH = w / imgRatio;
        } else {
            renderH = h;
            renderW = h * imgRatio;
        }
    } else {
        // Fill the box (crop sides/top)
        if (imgRatio > targetRatio) {
            renderH = h;
            renderW = h * imgRatio;
        } else {
            renderW = w;
            renderH = w / imgRatio;
        }
    }

    renderX = x + (w - renderW) / 2;
    renderY = y + (h - renderH) / 2;

    ctx.drawImage(img, renderX, renderY, renderW, renderH);
}

function updateScreenShareLayout() {
    // Check if anyone is sharing (local or remote)
    const isSharing = state.isScreenSharing || state.screenSharerId;

    if (!isSharing) {
        elements.screenShareLayout.classList.add('hidden');
        elements.videoGrid.classList.remove('hidden');
        elements.screenShareMain.srcObject = null;
        return;
    }

    elements.screenShareLayout.classList.remove('hidden');
    elements.videoGrid.classList.add('hidden');

    // Handle Main View (Screen Share)
    if (state.isScreenSharing) {
        // Local user is sharing
        elements.screenShareMain.srcObject = state.screenStream;
        elements.screenShareMain.muted = true; // Mute local preview
    } else {
        // Remote user is sharing
        const peerData = state.peers.get(state.screenSharerId);
        if (peerData && peerData.screenStream) {
            elements.screenShareMain.srcObject = peerData.screenStream;
            elements.screenShareMain.muted = false;
        }
    }

    renderScreenShareSidebar();
}

function renderScreenShareSidebar() {
    const sidebar = elements.screenShareSidebar;
    sidebar.innerHTML = ''; // Clear existing

    // Add local user camera
    const localPip = document.createElement('div');
    localPip.className = 'pip-container';

    // Video
    const localVideo = document.createElement('video');
    localVideo.autoplay = true;
    localVideo.muted = true;
    localVideo.playsInline = true;
    localVideo.srcObject = state.localStream;
    localPip.appendChild(localVideo);

    // Label
    const localLabel = document.createElement('div');
    localLabel.className = 'pip-label';
    localLabel.textContent = 'You' + (state.isHost ? ' (Host)' : '');
    localPip.appendChild(localLabel);

    sidebar.appendChild(localPip);

    // Add other participants
    state.peers.forEach((peerData, peerId) => {
        const pip = document.createElement('div');
        pip.className = 'pip-container';

        // Video
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.srcObject = peerData.stream;
        video.style.transform = 'scaleX(1)'; // Don't mirror remote video
        pip.appendChild(video);

        // Label
        const label = document.createElement('div');
        label.className = 'pip-label';
        label.textContent = peerData.name;
        pip.appendChild(label);

        // Mic status icon
        if (!peerData.isMicOn) {
            const micIcon = document.createElement('div');
            micIcon.className = 'pip-status';
            micIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"></path><path d="M17 16.95A7 7 0 015 12v-2m14 0v2c0 .57-.07 1.14-.22 1.68"></path><path d="M12 19v4M8 23h8"></path></svg>`;
            pip.appendChild(micIcon);
        }

        sidebar.appendChild(pip);
    });
}

function stopScreenShare() {
    if (state.screenStream) {
        state.screenStream.getTracks().forEach(track => track.stop());

        // Remove track from all peer connections
        state.peers.forEach(peerData => {
            if (peerData.screenSender) {
                try {
                    peerData.pc.removeTrack(peerData.screenSender);
                    peerData.screenSender = null;
                } catch (e) {
                    console.error('Error removing screen track:', e);
                }
            }
        });

        state.screenStream = null;
    }

    state.isScreenSharing = false;
    elements.screenBtn.classList.remove('active');

    // Update button label
    const label = elements.screenBtn.querySelector('span:last-child');
    if (label) {
        label.textContent = 'Share';
    }

    // Hide screen share layout
    // Hide screen share layout
    updateScreenShareLayout();

    sendSignaling({ type: 'stop-screen-share' });
    showToast('Screen sharing stopped', 'info');
}

// ============================================
// Recording (Host Only) - FIXED
// ============================================

function getSupportedMimeType() {
    for (const mimeType of CONFIG.recordingMimeTypes) {
        if (MediaRecorder.isTypeSupported(mimeType)) {
            console.log('Using mime type:', mimeType);
            return mimeType;
        }
    }
    return 'video/webm';
}

// Draw a single frame to the recording canvas (used for initial frame)
function drawRecordingFrame() {
    if (!state.recordingCanvas || !state.recordingCtx) return;

    const ctx = state.recordingCtx;
    const width = state.recordingCanvas.width;
    const height = state.recordingCanvas.height;

    // Clear canvas with dark background
    ctx.fillStyle = '#0f0f0f';
    ctx.fillRect(0, 0, width, height);

    // Draw local video if available
    if (elements.localVideo && elements.localVideo.srcObject && elements.localVideo.videoWidth > 0) {
        try {
            // Draw centered and mirrored
            ctx.save();
            ctx.translate(width, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(elements.localVideo, 0, 0, width, height);
            ctx.restore();
        } catch (e) {
            console.log('Could not draw initial frame:', e);
        }
    }

    // Draw "Starting recording..." text
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = '24px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Starting recording...', width / 2, height / 2);
    ctx.textAlign = 'left';
}

function startRecording() {
    if (!state.isHost) return;

    console.log('Starting recording...');

    // Create canvas for compositing all video streams
    state.recordingCanvas = document.createElement('canvas');
    // Reduced from 1080p to 720p for efficiency
    state.recordingCanvas.width = 1280;
    state.recordingCanvas.height = 720;
    state.recordingCtx = state.recordingCanvas.getContext('2d');

    // Pre-draw canvas with black background (required before captureStream)
    state.recordingCtx.fillStyle = '#0f0f0f';
    state.recordingCtx.fillRect(0, 0, 1280, 720);

    // Draw first frame immediately
    drawRecordingFrame();

    // Create audio context for mixing
    state.audioContext = new AudioContext();

    // Resume audio context (browsers suspend by default)
    state.audioContext.resume().then(() => {
        console.log('AudioContext resumed');
    });

    const destination = state.audioContext.createMediaStreamDestination();

    // Mix local audio
    if (state.localStream) {
        const localAudioTrack = state.localStream.getAudioTracks()[0];
        if (localAudioTrack && localAudioTrack.enabled) {
            try {
                const source = state.audioContext.createMediaStreamSource(new MediaStream([localAudioTrack]));
                source.connect(destination);
                console.log('Added local audio to recording');
            } catch (e) {
                console.error('Error adding local audio:', e);
            }
        }
    }

    // Mix remote audio
    state.peers.forEach((peerData, peerId) => {
        const remoteAudioTrack = peerData.stream.getAudioTracks()[0];
        if (remoteAudioTrack) {
            try {
                const source = state.audioContext.createMediaStreamSource(new MediaStream([remoteAudioTrack]));
                source.connect(destination);
                console.log('Added remote audio from', peerId);
            } catch (e) {
                console.error('Error adding remote audio:', e);
            }
        }
    });

    // Wait a bit for canvas to be ready, then start recording
    setTimeout(() => {
        // Get canvas stream at 24fps (better efficiency than 30fps)
        const canvasStream = state.recordingCanvas.captureStream(24);
        console.log('Canvas stream tracks:', canvasStream.getTracks().map(t => `${t.kind}:${t.readyState}`));

        // Combine video from canvas and mixed audio
        const tracks = [...canvasStream.getVideoTracks()];

        // Add audio track if available
        const audioTracks = destination.stream.getAudioTracks();
        if (audioTracks.length > 0) {
            tracks.push(audioTracks[0]);
        }

        const combinedStream = new MediaStream(tracks);
        console.log('Combined stream tracks:', combinedStream.getTracks().map(t => `${t.kind}:${t.readyState}`));

        // Get supported mime type
        const mimeType = getSupportedMimeType();

        try {
            state.mediaRecorder = new MediaRecorder(combinedStream, {
                mimeType: mimeType,
                videoBitsPerSecond: 2500000, // Reduced from 4Mbps to 2.5Mbps for better efficiency
                audioBitsPerSecond: 128000   // Explicit 128kbps audio
            });
            console.log('MediaRecorder created with:', mimeType, 'at 2.5Mbps');
        } catch (e) {
            console.error('MediaRecorder error:', e);
            showToast('Recording not supported in this browser', 'error');
            return;
        }

        state.recordedChunks = [];

        state.mediaRecorder.ondataavailable = (event) => {
            console.log('Data available:', event.data.size, 'bytes');
            if (event.data && event.data.size > 0) {
                state.recordedChunks.push(event.data);
            }
        };

        state.mediaRecorder.onerror = (event) => {
            console.error('MediaRecorder error:', event.error);
            showToast('Recording error', 'error');
        };

        state.mediaRecorder.onstop = () => {
            console.log('MediaRecorder stopped, chunks:', state.recordedChunks.length);
            saveRecording();
        };

        // Start recording with timeslice of 1000ms
        state.mediaRecorder.start(1000);
        console.log('MediaRecorder started, state:', state.mediaRecorder.state);

        // Start rendering to canvas
        state.recordingStartTime = Date.now();
        state.totalPausedTime = 0;
        state.lastPauseStartTime = null;

        state.isRecording = true;
        state.isRecordingPaused = false;

        // Initialize audio analysis for self and others
        if (state.localStream) initAudioAnalysis('local', state.localStream);
        state.peers.forEach((p, id) => {
            if (p.stream) initAudioAnalysis(id, p.stream);
        });

        renderRecordingFrame();

        // Update recording time every second
        state.recordingTimeInterval = setInterval(updateRecordingTime, 1000);

        // Update UI
        elements.recordBtn.classList.add('hidden');
        elements.pauseRecordBtn.classList.remove('hidden');
        elements.stopRecordBtn.classList.remove('hidden');
        elements.recordingIndicator.classList.remove('hidden');

        sendSignaling({ type: 'recording-started' });
        showToast('Recording started', 'success');
    }, 100); // Small delay to ensure canvas is ready
}

function pauseRecording() {
    if (!state.mediaRecorder || !state.isRecording) return;

    if (state.isRecordingPaused) {
        // RESUME
        state.mediaRecorder.resume();
        state.isRecordingPaused = false;

        // Calculate paused duration
        if (state.lastPauseStartTime) {
            const pausedDuration = Date.now() - state.lastPauseStartTime;
            state.totalPausedTime += pausedDuration;
            state.lastPauseStartTime = null;
        }

        elements.pauseRecordBtn.classList.remove('paused');
        elements.pauseRecordBtn.querySelector('span:last-child').textContent = 'Pause';
        elements.recordingIndicator.classList.remove('paused');
        showToast('Recording resumed', 'info');
    } else {
        // PAUSE
        state.mediaRecorder.pause();
        state.isRecordingPaused = true;

        // Track pause start time
        state.lastPauseStartTime = Date.now();

        elements.pauseRecordBtn.classList.add('paused');
        elements.pauseRecordBtn.querySelector('span:last-child').textContent = 'Resume';
        elements.recordingIndicator.classList.add('paused');
        showToast('Recording paused', 'info');
    }
}

function stopRecording() {
    if (!state.mediaRecorder || !state.isRecording) return;

    console.log('Stopping recording...');

    // Stop the MediaRecorder
    if (state.mediaRecorder.state !== 'inactive') {
        state.mediaRecorder.stop();
    }

    // Stop rendering
    if (state.recordingAnimationId) {
        cancelAnimationFrame(state.recordingAnimationId);
        state.recordingAnimationId = null;
    }

    // Clear time interval
    if (state.recordingTimeInterval) {
        clearInterval(state.recordingTimeInterval);
        state.recordingTimeInterval = null;
    }

    // Close audio context
    if (state.audioContext) {
        state.audioContext.close();
        state.audioContext = null;
    }

    state.isRecording = false;
    state.isRecordingPaused = false;

    // Update UI
    elements.recordBtn.classList.remove('hidden');
    elements.pauseRecordBtn.classList.add('hidden');
    elements.stopRecordBtn.classList.add('hidden');
    elements.recordingIndicator.classList.add('hidden');
    if (elements.recordingTime) {
        elements.recordingTime.textContent = '00:00';
    }

    sendSignaling({ type: 'recording-stopped' });
    showToast('Recording stopped', 'info');
}

function renderRecordingFrame() {
    if (!state.isRecording) return;
    if (state.isRecordingPaused) {
        state.recordingAnimationId = requestAnimationFrame(renderRecordingFrame);
        return;
    }

    const ctx = state.recordingCtx;
    const canvas = state.recordingCanvas;
    const width = canvas.width;
    const height = canvas.height;

    // Clear canvas
    ctx.fillStyle = '#0f0f0f';
    ctx.fillRect(0, 0, width, height);

    // Update active speaker detection
    updateActiveSpeakers();

    // 1. CHECK IF SCREEN SHARING (BY ANYONE)
    const isSharing = state.isScreenSharing || state.screenSharerId;
    let screenVideoElement = null;

    if (state.isScreenSharing) {
        screenVideoElement = elements.screenShareMain; // Local sharing
    } else if (state.screenSharerId) {
        // Find existing playback element
        // Since logic already sets screenShareMain for remote viewers, we can rely on it
        // BUT for the screen sharer themselves (recording host), they might be viewing someone else?
        // Actually, if screenSharerId is set, 'updateScreenShareLayout' logic ensures 'screenShareMain' has the stream.
        screenVideoElement = elements.screenShareMain;
        if (screenVideoElement && screenVideoElement.paused) screenVideoElement.play().catch(() => { });
    }

    if (isSharing && screenVideoElement && screenVideoElement.srcObject) {
        // --- RENDER SCREEN SHARE LAYOUT ---

        // Main Screen (Left side, ~80% width)
        const mainW = width * 0.8;
        const mainH = height;

        // Draw main screen if ready
        if (screenVideoElement.readyState >= 2) {
            // Use 'contain' mode for screen share so nothing is cropped
            drawImageAspect(ctx, screenVideoElement, 0, 0, mainW, mainH, 'contain');
        } else {
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, mainW, mainH);
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'center';
            ctx.fillText('Loading screen share...', mainW / 2, mainH / 2);
            ctx.textAlign = 'left';
        }

        // Sidebar (Right side, 20% width)
        const sidebarX = mainW;
        const sidebarW = width - mainW;

        // Background for sidebar
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(sidebarX, 0, sidebarW, height);

        // Gather and Filter participants
        let participants = [];

        // Self
        if (state.localStream) {
            participants.push({
                id: 'local',
                stream: state.localStream,
                name: state.name || "You",
                videoEl: elements.localVideo,
                isLocal: true,
                isCameraOn: state.isCameraOn,
                isSpeaking: state.speakingParticipants.has('local')
            });
        }

        // Others
        state.peers.forEach((p, id) => {
            participants.push({
                id: id,
                stream: p.stream,
                name: p.name,
                videoEl: p.videoElement,
                isLocal: false,
                isCameraOn: p.isCameraOn,
                isSpeaking: state.speakingParticipants.has(id)
            });
        });

        // Smart Filtering for Sidebar
        if (state.hideInactive) {
            participants = participants.filter(p => p.isCameraOn || p.isSpeaking || p.id === state.pinnedParticipantId);
        }

        // Draw them in a vertical column
        const videoH = sidebarW * (9 / 16); // 16:9 aspect ratio
        const padding = 10;
        let currentY = padding;

        participants.forEach(p => {
            if (currentY + videoH > height) return; // No space

            // Draw video or placeholder
            if (p.isCameraOn && p.videoEl && p.videoEl.readyState >= 2) {
                if (p.videoEl.paused) p.videoEl.play().catch(() => { });
                ctx.save();
                ctx.translate(sidebarX + padding, currentY);

                // Clip to rounded rect
                ctx.beginPath();
                ctx.roundRect(0, 0, sidebarW - (padding * 2), videoH, 8);
                ctx.clip();

                if (p.isLocal) {
                    ctx.save();
                    ctx.translate(sidebarW - (padding * 2), 0);
                    ctx.scale(-1, 1);
                    drawImageAspect(ctx, p.videoEl, 0, 0, sidebarW - (padding * 2), videoH, 'cover');
                    ctx.restore();
                } else {
                    drawImageAspect(ctx, p.videoEl, 0, 0, sidebarW - (padding * 2), videoH, 'cover');
                }

                ctx.restore();
            } else {
                // Placeholder for no video but speaking or pinned
                ctx.save();
                ctx.translate(sidebarX + padding, currentY);
                ctx.beginPath();
                ctx.roundRect(0, 0, sidebarW - (padding * 2), videoH, 8);
                ctx.clip();

                ctx.fillStyle = p.isSpeaking ? '#1a3a2a' : '#222';
                ctx.fillRect(0, 0, sidebarW - (padding * 2), videoH);

                // Active speaker indicator icon
                if (p.isSpeaking) {
                    ctx.fillStyle = '#4ade80';
                    ctx.beginPath();
                    ctx.arc((sidebarW - padding * 2) / 2, videoH / 2, 15, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }

            // Name Label (Always show)
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillRect(sidebarX + padding, currentY + videoH - 24, sidebarW - (padding * 2), 24);
            ctx.fillStyle = '#fff';
            ctx.font = '14px Inter';
            ctx.fillText(p.name, sidebarX + padding + 8, currentY + videoH - 8);

            // Highlight if speaking (Rounded border OVER EVERYTHING)
            if (p.isSpeaking) {
                ctx.save();
                ctx.translate(sidebarX + padding, currentY);
                ctx.strokeStyle = '#4ade80';
                ctx.lineWidth = 4;
                ctx.beginPath();
                ctx.roundRect(0, 0, sidebarW - (padding * 2), videoH, 8);
                ctx.stroke();
                ctx.restore();
            }

            currentY += videoH + padding;
        });

    } else {
        // --- RENDER GRID LAYOUT ---
        // Gather all visible videos
        // Gather and Filter participants
        let participants = [];

        // Self
        if (state.localStream) {
            participants.push({
                id: 'local',
                video: elements.localVideo,
                name: state.name || "You",
                isLocal: true,
                isCameraOn: state.isCameraOn,
                isSpeaking: state.speakingParticipants.has('local')
            });
        }

        // Others
        state.peers.forEach((p, id) => {
            if (p.videoElement) {
                participants.push({
                    id: id,
                    video: p.videoElement,
                    name: p.name,
                    isLocal: false,
                    isCameraOn: p.isCameraOn,
                    isSpeaking: state.speakingParticipants.has(id)
                });
            }
        });

        // Pin Logic for Grid: If pin is active, put them first and maybe handle specially
        if (state.pinnedParticipantId) {
            const pinIndex = participants.findIndex(p => p.id === state.pinnedParticipantId);
            if (pinIndex > -1) {
                const pinned = participants.splice(pinIndex, 1)[0];
                participants.unshift(pinned);
            }
        }

        // Smart Filtering for Grid
        if (state.hideInactive) {
            participants = participants.filter(p => p.isCameraOn || p.isSpeaking || p.id === state.pinnedParticipantId);
        }

        const count = participants.length;
        if (count === 0) {
            state.recordingAnimationId = requestAnimationFrame(renderRecordingFrame);
            return;
        }

        // Simple Grid Logic
        let cols = 1;
        let rows = 1;

        if (count === 2) { cols = 2; }
        else if (count > 2) { cols = 2; rows = 2; } // Max 4 for now

        const cellW = width / cols;
        const cellH = height / rows;

        participants.forEach((p, index) => {
            if (index >= 4) return; // Limit to 4

            const col = index % cols;
            const row = Math.floor(index / cols);
            const x = col * cellW;
            const y = row * cellH;

            // Aspect fit logic
            // We want to fill the cell, possibly cropping (object-fit: cover)
            if (p.video && p.video.readyState >= 2 && p.isCameraOn) {
                const vRatio = p.video.videoWidth / p.video.videoHeight;
                const cRatio = cellW / cellH;

                let renderW, renderH, renderX, renderY;

                if (vRatio > cRatio) {
                    // Video is wider than cell (crop sides)
                    renderH = cellH;
                    renderW = cellH * vRatio;
                    renderX = x - (renderW - cellW) / 2;
                    renderY = y;
                } else {
                    // Video is taller than cell (crop top/bottom)
                    renderW = cellW;
                    renderH = cellW / vRatio;
                    renderX = x;
                    renderY = y - (renderH - cellH) / 2;
                }

                ctx.save();
                // Create clipping region for this cell
                ctx.beginPath();
                ctx.rect(x, y, cellW, cellH);
                ctx.clip();

                if (p.isLocal) {
                    ctx.translate(renderX + renderW, renderY);
                    ctx.scale(-1, 1);
                    ctx.drawImage(p.video, 0, 0, renderW, renderH);
                } else {
                    ctx.drawImage(p.video, renderX, renderY, renderW, renderH);
                }

                ctx.restore();
            } else {
                // Placeholder for Grid mode
                ctx.fillStyle = p.isSpeaking ? '#1a3a2a' : '#222';
                ctx.fillRect(x, y, cellW, cellH);

                if (p.isSpeaking) {
                    ctx.fillStyle = '#4ade80';
                    ctx.beginPath();
                    ctx.arc(x + cellW / 2, y + cellH / 2 - 10, 30, 0, Math.PI * 2);
                    ctx.fill();
                }
            }

            // Draw Name Label in Grid
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.fillRect(x, y + cellH - 30, cellW, 30);
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 16px Inter';
            ctx.textAlign = 'center';
            ctx.fillText(p.name, x + cellW / 2, y + cellH - 10);
            ctx.textAlign = 'left'; // Reset

            // DRAW BORDER LAST (OVER EVERYTHING)
            if (p.isSpeaking) {
                ctx.save();
                ctx.strokeStyle = '#4ade80';
                ctx.lineWidth = 6;
                // Inset slightly to avoid edge clipping
                ctx.strokeRect(x + 3, y + 3, cellW - 6, cellH - 6);
                ctx.restore();
            }
        });
    }

    state.recordingAnimationId = requestAnimationFrame(renderRecordingFrame);
}




function saveRecording() {
    if (state.recordedChunks.length === 0) {
        console.error('No recorded chunks to save');
        showToast('Recording failed - no data captured', 'error');
        return;
    }

    console.log('Saving recording, chunks:', state.recordedChunks.length);

    const blob = new Blob(state.recordedChunks, { type: 'video/webm' });
    console.log('Blob size:', blob.size, 'bytes');

    if (blob.size === 0) {
        showToast('Recording failed - empty file', 'error');
        return;
    }

    const url = URL.createObjectURL(blob);

    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
    const filename = `meeting-${state.roomId}-${timestamp}.webm`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showToast(`Recording saved: ${filename}`, 'success');
}

// ============================================
// Room Management
// ============================================

async function createRoom() {
    const name = elements.nameInput.value.trim();
    if (!name) {
        showToast('Please enter your name', 'error');
        elements.nameInput.focus();
        return;
    }

    state.name = name;

    // Initialize media first
    const mediaReady = await initLocalMedia();
    if (!mediaReady) return;

    // Connect WebSocket and create room
    connectWebSocket();

    state.ws.onopen = () => {
        sendSignaling({
            type: 'create-room',
            name: state.name
        });
    };
}

async function joinRoom() {
    const name = elements.nameInput.value.trim();
    const roomId = elements.roomInput.value.trim().toUpperCase();

    if (!name) {
        showToast('Please enter your name', 'error');
        elements.nameInput.focus();
        return;
    }

    if (!roomId) {
        showToast('Please enter Room ID', 'error');
        elements.roomInput.focus();
        return;
    }

    state.name = name;

    // Initialize media first
    const mediaReady = await initLocalMedia();
    if (!mediaReady) return;

    // Connect WebSocket and join room
    connectWebSocket();

    state.ws.onopen = () => {
        sendSignaling({
            type: 'join-room',
            roomId: roomId,
            name: state.name
        });
    };
}

function enterMeeting() {
    elements.lobby.classList.remove('active');
    elements.meeting.classList.add('active');

    elements.roomIdDisplay.textContent = state.roomId;
    elements.localName.textContent = state.name;

    // Show host badge and record button if host
    if (state.isHost) {
        elements.localVideoContainer.querySelector('.host-badge').classList.remove('hidden');
        elements.recordBtn.classList.remove('hidden');
    }

    updateVideoGridLayout();
}

function leaveMeeting() {
    // Stop recording if active
    if (state.isRecording) {
        stopRecording();
    }

    // Stop all media
    if (state.localStream) {
        state.localStream.getTracks().forEach(track => track.stop());
        state.localStream = null;
    }

    if (state.screenStream) {
        state.screenStream.getTracks().forEach(track => track.stop());
        state.screenStream = null;
    }

    // Close all peer connections
    state.peers.forEach((peerData) => {
        peerData.pc.close();
        if (peerData.videoElement) {
            peerData.videoElement.parentElement.remove();
        }
    });
    state.peers.clear();

    // Close WebSocket
    if (state.ws) {
        state.ws.close();
        state.ws = null;
    }

    // Reset state
    state.roomId = null;
    state.participantId = null;
    state.isHost = false;
    state.isMicOn = true;
    state.isCameraOn = true;
    state.isScreenSharing = false;

    // Reset UI
    elements.meeting.classList.remove('active');
    elements.lobby.classList.add('active');
    elements.micBtn.classList.remove('off');
    elements.cameraBtn.classList.remove('off');
    elements.screenBtn.classList.remove('active');
    elements.recordBtn.classList.add('hidden');
    elements.pauseRecordBtn.classList.add('hidden');
    elements.stopRecordBtn.classList.add('hidden');
    elements.recordingIndicator.classList.add('hidden');
    elements.localVideoContainer.querySelector('.host-badge').classList.add('hidden');
    elements.localVideo.srcObject = null;

    // Hide screen share layout
    hideScreenShareLayout();

    // Reset button labels
    elements.micBtn.querySelector('span:last-child').textContent = 'Mic On';
    elements.cameraBtn.querySelector('span:last-child').textContent = 'Cam On';
    elements.screenBtn.querySelector('span:last-child').textContent = 'Share';
}

function copyRoomId() {
    navigator.clipboard.writeText(state.roomId).then(() => {
        showToast('Room ID copied!', 'success');
    }).catch(() => {
        showToast('Failed to copy', 'error');
    });
}

// ============================================
// Event Listeners
// ============================================

elements.createBtn.addEventListener('click', createRoom);
elements.joinBtn.addEventListener('click', joinRoom);
elements.copyRoomBtn.addEventListener('click', copyRoomId);
elements.micBtn.addEventListener('click', toggleMic);
elements.cameraBtn.addEventListener('click', toggleCamera);
elements.screenBtn.addEventListener('click', toggleScreenShare);
elements.recordBtn.addEventListener('click', startRecording);
elements.hideInactiveBtn.addEventListener('click', toggleHideInactive);
elements.pauseRecordBtn.addEventListener('click', pauseRecording);
elements.stopRecordBtn.addEventListener('click', stopRecording);
elements.leaveBtn.addEventListener('click', leaveMeeting);

// Enter key to join
elements.roomInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') joinRoom();
});

elements.nameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !elements.roomInput.value) createRoom();
});

// Prevent accidental page leave during meeting
window.addEventListener('beforeunload', (e) => {
    if (state.roomId) {
        e.preventDefault();
        e.returnValue = '';
    }
});

console.log('Zoom Lite Offline v2.0 - Ready');
