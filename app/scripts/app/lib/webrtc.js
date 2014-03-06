// TODO: provide TURN server config
// once it's possible to create rooms with custom names.
FileDrop.WebRTC = function (options) {
    this.conn = new Peer({ // PeerJS client library
        host: 'file-drop-peer-server.herokuapp.com',
        port: 80,
        config: {'iceServers': [
            { url: 'stun:stun.l.google.com:19302' }
        ]},
        debug: 3
    });

    this.files = {
        outgoing: {},
        incoming: {}
    };

    // When connected to PeerJS server
    this.conn.on('open', function (id) {
        var self = this;

        $.publish('connected.server.peer', {id: id});
        console.log('Peer:\t Connected to server with ID: ', id);

        // TODO: cancel on error/disconnect
        // Ping WebSocket server to prevent timeout on Heroku
        window.setInterval(function () {
            self.socket.send({type: 'ping'});
        }, 5000);
    });

    // Listen for incoming connections
    this.conn.on('connection', this._onConnection.bind(this));

    this.conn.on('close', function () {
        console.log('Peer:\t Connected to server closed.');
    });

    this.conn.on('error', function (error) {
        console.log('Peer:\t Error while connecting to server: ', error);
    });

    // Make sure PeerJS connection is cleaned up
    window.onunload = window.onbeforeunload = function () {
        if (!!this.conn && !this.conn.destroyed) {
            this.conn.destroy();
        }
    };
};

FileDrop.WebRTC.CHUNKS_PER_ACK = 64;

FileDrop.WebRTC.prototype.connect = function (id) {
    var connection = this.conn.connect(id, {
        label: 'file',
        reliable: true,
        serialization: 'none' // we handle serialization ourselves
    });

    connection.on('open', function () {
        this._onConnection(connection);
    }.bind(this));

    connection.on('error', function (error) {
        console.log('Peer:\t P2P connection error', error);
    }.bind(this));
};

FileDrop.WebRTC.prototype._onConnection = function (connection) {
    var self = this;

    $.publish('connected.p2p.peer', {connection: connection});
    console.log('Peer:\t P2P connection opened: ', connection);

    connection.on('data', function (data) {
        // Lame type check
        if (data.byteLength !== undefined) {
            // ArrayBuffer
            self._onBinaryData(data, connection);
        } else {
            // JSON string
            self._onJSONData(JSON.parse(data), connection);
        }
    });

    connection.on('close', function () {
        $.publish('disconnected.p2p.peer', {connection: connection});
        console.log('Peer:\t P2P connection opened: ', connection);
    });
};

FileDrop.WebRTC.prototype._onBinaryData = function (data, connection) {
    var self = this,
        incoming = this.files.incoming[connection.peer],
        block = incoming.block,
        info = incoming.info,
        receivedChunkNum = incoming.receivedChunkNum,
        chunksPerAck = FileDrop.WebRTC.CHUNKS_PER_ACK,
        nextChunkNum, lastChunkInFile, lastChunkInBlock;

    connection.emit('receiving_progress', receivedChunkNum / (info.chunksTotal - 1));
    // console.log('Got chunk no ' + (receivedChunkNum + 1) + ' out of ' + info.chunksTotal);

    block.push(data);

    nextChunkNum = incoming.receivedChunkNum = receivedChunkNum + 1;
    lastChunkInFile = receivedChunkNum === info.chunksTotal - 1;
    lastChunkInBlock = receivedChunkNum > 0 && ((receivedChunkNum + 1) % chunksPerAck) === 0;

    if (lastChunkInFile || lastChunkInBlock) {
        this.file.append(block).then(function () {
            if (lastChunkInFile) {
                self.file.save();

                $.publish('file.p2p.peer', {
                    blob: self.file,
                    connection: connection
                });
            } else {
                // console.log('Requesting block starting at: ' + (nextChunkNum));
                incoming.block = [];
                self._requestFileBlock(connection, nextChunkNum);
            }
        });
    }
};

FileDrop.WebRTC.prototype._onJSONData = function (data, connection) {
    switch (data.type) {
    case 'info':
        var info = data.payload;

        $.publish('info.p2p.peer', {
            connection: connection,
            info: info
        });

        // Store incoming file info for later
        this.files.incoming[connection.peer] = {
            info: info,
            cache: []
        };

        console.log('Peer:\t File info: ', data);
        break;

    case 'response':
        var response = data.payload;

        // If recipient rejected the file, delete stored file
        if (!response) {
            delete this.files.outgoing[connection.peer];
        }

        $.publish('response.p2p.peer', {
            connection: connection,
            response: response
        });

        console.log('Peer:\t File response: ', data);
        break;

    case 'block_request':
        var file = this.files.outgoing[connection.peer].file;

        // console.log('Peer:\t Block request: ', data.payload);

        this._sendBlock(connection, file, data.payload);
        break;
    default:
        console.log('Peer:\t Unknown message: ', data);
    }
};

FileDrop.WebRTC.prototype.getFileInfo = function (file) {
    return {
        lastModifiedDate: file.lastModifiedDate,
        name: file.name,
        size: file.size,
        type: file.type,
        chunksTotal: Math.ceil(file.size / Peer.CHUNK_MTU)
    };
};

FileDrop.WebRTC.prototype.sendFileInfo = function (connection, info) {
    var message = {
        type: 'info',
        payload: info
    };

    connection.send(JSON.stringify(message));
};

FileDrop.WebRTC.prototype.sendFileResponse = function (connection, response) {
    var self = this,
        message = {
            type: 'response',
            payload: response
        };

    if (response) {
        // If recipient accepted the file, request required space to store the file on HTML5 filesystem
        var incoming = this.files.incoming[connection.peer],
            info = incoming.info;

        new FileDrop.File({name: info.name, size: info.size, type: info.type})
        .then(function (file) {
            self.file = file;

            incoming.block = [];
            incoming.receivedChunkNum = 0;

            connection.send(JSON.stringify(message));
        });
    } else {
        // Otherwise, delete stored file info
        delete this.files.incoming[connection.peer];
        connection.send(JSON.stringify(message));
    }
};

FileDrop.WebRTC.prototype.sendFile = function (connection, file) {
    // Save the file for later
    this.files.outgoing[connection.peer] = {
        file: file,
        info: this.getFileInfo(file)
    };

    // Send the first block. Next ones will be requested by recipient.
    this._sendBlock(connection, file, 0);
};

FileDrop.WebRTC.prototype._requestFileBlock = function (connection, chunkNum) {
    var message = {
        type: 'block_request',
        payload: chunkNum
    };
    connection.send(JSON.stringify(message));
};

// FIXME: Figure out why 64th chunk is sent twice
FileDrop.WebRTC.prototype._sendBlock = function (connection, file, beginChunkNum) {
    var info = this.files.outgoing[connection.peer].info,
        chunksPerAck = FileDrop.WebRTC.CHUNKS_PER_ACK,
        remainingChunks = info.chunksTotal - beginChunkNum,
        chunksToSend = Math.min(remainingChunks, chunksPerAck),
        endChunkNum = beginChunkNum + chunksToSend - 1,
        chunkNum;

    // console.log('Send block: start: ' + beginChunkNum + ' end: ' + endChunkNum);

    for (chunkNum = beginChunkNum; chunkNum <  endChunkNum + 1; chunkNum++) {
        this._sendChunk(connection, file, chunkNum);
    }
};

// TODO: check for finish condition (if end is file.size => last chunk)
FileDrop.WebRTC.prototype._sendChunk = function (connection, file, chunkNum) {
    var info = this.files.outgoing[connection.peer].info,
        chunkSize = Peer.CHUNK_MTU,
        begin, end, blob;

    var reader = new FileReader;
    begin = chunkNum * chunkSize;
    end = Math.min(begin + chunkSize, info.size);

    blob = file.slice(begin, end);

    reader.onload = function(event) {
        if (reader.readyState == FileReader.DONE) {
            connection.send(event.target.result);

            connection.emit('sending_progress', chunkNum / (info.chunksTotal - 1));
            // console.log('Sent chunk no ' + (chunkNum + 1) + ' out of ' + info.chunksTotal);
        }
    };
    reader.readAsArrayBuffer(blob);
};