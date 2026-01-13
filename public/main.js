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
    // Media constraints
    mediaConstraints: {
        video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: 'user'
        },
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        }
    },
    // Screen share constraints
    screenConstraints: {
        video: {
            cursor: 'always',
            displaySurface: 'monitor'
        },
        audio: true
    },
    // Recording settings - use more compatible codec
    recordingMimeTypes: [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
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
    peers: new Map(), // participantId -> { pc, stream, name, isHost }

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
    screenSharerId: null
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

    state.ws.onopen = () => {
        console.log('WebSocket connected');
    };

    state.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleSignalingMessage(data);
    };

    state.ws.onclose = () => {
        console.log('WebSocket disconnected');
        if (state.roomId) {
            showToast('Connection lost', 'error');
            leaveMeeting();
        }
    };

    state.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        showToast('Connection error', 'error');
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
            updateScreenShareLayout();
            showToast(`${data.participantId} started screen sharing`, 'info');
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

        case 'error':
            showToast(data.message, 'error');
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
        screenStream: null
    };

    state.peers.set(peerId, peerData);

    // Add local tracks to connection
    if (state.localStream) {
        state.localStream.getTracks().forEach(track => {
            pc.addTrack(track, state.localStream);
        });
    }

    // Handle incoming tracks
    pc.ontrack = (event) => {
        console.log(`Received track from ${peerId}:`, event.track.kind);

        // Logic to distinguish camera vs screen share
        // If we already have a video track in the main stream, the new video track is likely screen share
        const existingVideoTracks = peerData.stream.getVideoTracks();

        if (event.track.kind === 'video' && existingVideoTracks.length > 0) {
            console.log(`Received screen share track from ${peerId}`);
            if (!peerData.screenStream) {
                peerData.screenStream = new MediaStream();
            }
            peerData.screenStream.addTrack(event.track);

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

    // Handle connection state
    pc.onconnectionstatechange = () => {
        console.log(`Connection state with ${peerId}: ${pc.connectionState}`);
        if (pc.connectionState === 'failed') {
            showToast(`Connection to ${peerName} failed`, 'error');
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

        // Add screen track to peer connections (don't replace, add new track)
        state.peers.forEach((peerData) => {
            peerData.pc.addTrack(screenTrack, state.screenStream);
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

        sendSignaling({ type: 'start-screen-share' });
        showToast('Screen sharing started', 'success');

    } catch (error) {
        console.error('Error starting screen share:', error);
        if (error.name !== 'AbortError') {
            showToast('Cannot share screen', 'error');
        }
    }
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
    state.recordingCanvas.width = 1920;
    state.recordingCanvas.height = 1080;
    state.recordingCtx = state.recordingCanvas.getContext('2d');

    // Pre-draw canvas with black background (required before captureStream)
    state.recordingCtx.fillStyle = '#0f0f0f';
    state.recordingCtx.fillRect(0, 0, 1920, 1080);

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
        // Get canvas stream at 30fps
        const canvasStream = state.recordingCanvas.captureStream(30);
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

        // Start MediaRecorder
        try {
            state.mediaRecorder = new MediaRecorder(combinedStream, {
                mimeType: mimeType,
                videoBitsPerSecond: 4000000
            });
            console.log('MediaRecorder created with:', mimeType);
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
    }

    if (isSharing && screenVideoElement && screenVideoElement.srcObject) {
        // --- RENDER SCREEN SHARE LAYOUT ---

        // Main Screen (Left side, ~80% width)
        const mainW = width * 0.8;
        const mainH = height;

        ctx.drawImage(screenVideoElement, 0, 0, mainW, mainH);

        // Sidebar (Right side, 20% width)
        const sidebarX = mainW;
        const sidebarW = width - mainW;

        // Background for sidebar
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(sidebarX, 0, sidebarW, height);

        // Gather all participants including self
        const participants = [];

        // Self
        if (state.localStream) {
            participants.push({
                stream: state.localStream,
                name: "You",
                videoEl: elements.localVideo,
                isLocal: true
            });
        }

        // Others
        state.peers.forEach(p => {
            participants.push({
                stream: p.stream,
                name: p.name,
                videoEl: p.videoElement,
                isLocal: false
            });
        });

        // Draw them in a vertical column
        const videoH = sidebarW * (9 / 16); // 16:9 aspect ratio
        const padding = 10;
        let currentY = padding;

        participants.forEach(p => {
            if (currentY + videoH > height) return; // No space

            // Draw video
            if (p.videoEl && p.videoEl.readyState >= 2) { // HAVE_CURRENT_DATA
                ctx.save();
                ctx.translate(sidebarX + padding, currentY);

                // Clip to rounded rect
                ctx.beginPath();
                ctx.roundRect(0, 0, sidebarW - (padding * 2), videoH, 8);
                ctx.clip();

                if (p.isLocal) {
                    // Mirror local
                    ctx.translate(sidebarW - (padding * 2), 0);
                    ctx.scale(-1, 1);
                    ctx.drawImage(p.videoEl, 0, 0, sidebarW - (padding * 2), videoH);
                } else {
                    ctx.drawImage(p.videoEl, 0, 0, sidebarW - (padding * 2), videoH);
                }
                ctx.restore();

                // Name Label
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                ctx.fillRect(sidebarX + padding, currentY + videoH - 24, sidebarW - (padding * 2), 24);
                ctx.fillStyle = '#fff';
                ctx.font = '14px Inter';
                ctx.fillText(p.name, sidebarX + padding + 8, currentY + videoH - 8);

            } else {
                // Placeholder for no video
                ctx.fillStyle = '#333';
                ctx.fillRect(sidebarX + padding, currentY, sidebarW - (padding * 2), videoH);
                ctx.fillStyle = '#fff';
                ctx.fillText(p.name, sidebarX + padding + 20, currentY + videoH / 2);
            }

            currentY += videoH + padding;
        });

    } else {
        // --- RENDER GRID LAYOUT ---
        // Gather all visible videos
        const participants = [];

        if (state.localStream) {
            participants.push({
                video: elements.localVideo,
                isLocal: true
            });
        }

        state.peers.forEach(p => {
            if (p.videoElement) {
                participants.push({
                    video: p.videoElement,
                    isLocal: false
                });
            }
        });

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
            if (p.video && p.video.readyState >= 2) {
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
                    // Mirror local
                    // To mirror around the center of the rendered image:
                    ctx.translate(renderX + renderW, renderY);
                    ctx.scale(-1, 1);
                    ctx.drawImage(p.video, 0, 0, renderW, renderH);
                } else {
                    ctx.drawImage(p.video, renderX, renderY, renderW, renderH);
                }
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
