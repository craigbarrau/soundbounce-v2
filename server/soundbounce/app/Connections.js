import _debug from 'debug';
const debug = _debug('soundbounce:connections');

export default class Connections {
	constructor(app) {
		this.app = app;
		this.connectedSockets = [];
	}

	getConnectedUsersForRoom(roomId) {
		const users = [];
		// a user may have multiple sockets, but we just want the unique users
		// we could in theory query this from db but that would end up slow / bottlenecking
		for (let socket of this.connectedSockets) {
			if (socket.authenticatedUser.get('currentRoomId') === roomId) {
				if (!users.find(u => u.get('id') === socket.authenticatedUser.get('id'))) {
					users.push(socket.authenticatedUser);
				}
			}
		}
		return users;
	}

	addAuthenticatedSocket({socket, authenticatedUser}) {
		const plainUserObject = authenticatedUser.get({plain: true});
		// send the current user info back to the client
		socket.emit('user:auth:ok', plainUserObject);

		socket.on('disconnect', s => {
			this.removeClient(socket);
		});

		// check if any other clients already connected have this id, and use their user object
		for (let otherSocket of this.connectedSockets) {
			if (otherSocket.authenticatedUser.get('id') === plainUserObject.id) {
				authenticatedUser = otherSocket.authenticatedUser;
				break;
			}
		}

		// attach some useful info to the socket
		socket.authenticatedUser = authenticatedUser;
		socket.debugUserName = `${plainUserObject.nickname} (${plainUserObject.id})`;

		// join room shared for all logged in instances of this user
		socket.allSocketsForThisUser = `user:${plainUserObject.id}`;
		socket.join(socket.allSocketsForThisUser);

		this.connectedSockets.push(socket);
		this.addSocketEventListeners(socket);
		debug(`${socket.debugUserName} connected, ${this.connectedSockets.length} total clients.`);
	}

	joinRoom({socket, roomId}) {
		socket.join(`room:${roomId}`);
		this.app.rooms.joinRoom(roomId, socket.authenticatedUser).then(room => {
			console.log('emitting now');
			this.app.io.to(socket.allSocketsForThisUser).emit('room:join:ok', {room});
		});
	}

	addSocketEventListeners(socket) {
		socket.on('room:create', (roomOptions) => {
			this.app.rooms.createRoom(roomOptions)
				.then(room => {
					room.setCreator(socket.authenticatedUser);
					room.save().then(() => {
						socket.emit('room:create:ok', room.get({plain: true}));
						this.joinRoom({socket, roomId: room.get('id')});
					});
				});
		});

		socket.on('room:join', roomId => {
			this.joinRoom({socket, roomId})
		});

		socket.on('user:current', () => {
			socket.emit('user:current:ok', socket.authenticatedUser.get({plain: true}));
		});

		socket.on('room:event', ({roomId, event}) => {
			const activeRoom = this.app.rooms.findActiveRoom(roomId);
			if (!activeRoom) {
				debug('Unable to process room message for inactive room ' + roomId);
				return;
			}
			activeRoom.handleRoomEventMessage({sender: socket.authenticatedUser, event});
		});
	}

	removeClient(socket) {
		// remove from the connectedSockets list
		this.connectedSockets = this.connectedSockets.filter(sock => sock !== socket);
		debug(`${socket.debugUserName} disconnected, ${this.connectedSockets.length} clients connected.`);

		const userHasOtherSocketsOpen = this.connectedSockets.filter(sock => sock.authenticatedUser.get('id') === socket.authenticatedUser.get('id')).length > 0;

		if (!userHasOtherSocketsOpen) {
			// this was the last socket closed by this user, so leave any room they might be in
			const roomId = socket.authenticatedUser.get('currentRoomId');
			if (roomId) {
				this.app.rooms.leaveRoom(roomId, socket.authenticatedUser);
			}
		}
	}
}
