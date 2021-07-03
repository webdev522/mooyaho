import { v4 } from 'uuid'
import WebSocket from 'ws'
import {
  AnswerAction,
  CallAction,
  CandidateAction,
  Message,
  ReceiveAction,
} from './actions/receive'
import actionCreators from './actions/send'
import { createHmac } from 'crypto'
import { globalSubscriber } from './redis/createRedisClient'
import subscription from './redis/subscription'
import channelHelper from './channelHelper'
import prefixer from './redis/prefixer'
import rtcHelper from './rtcHelper'
import { Description } from './actions/common'
import sessionService from '../../services/sessionService'
import channelService from '../../services/channelService'
import config from '../../configLoader'
import { Client } from 'mooyaho-grpc'

const grpcClient = new Client('localhost:50000')

function startListenSignal() {
  grpcClient
    .listenSignal(signal => {
      if (signal.type === 'icecandidate') {
        subscription.dispatch(
          prefixer.direct(signal.sessionId),
          actionCreators.candidated(
            signal.fromSessionId!,
            JSON.parse(signal.candidate),
            true
          )
        )
      } else if (signal.type === 'offer') {
        subscription.dispatch(
          prefixer.direct(signal.sessionId),
          actionCreators.called(signal.fromSessionId, signal.sdp, true)
        )
      }
    })
    .catch(e => {
      setTimeout(startListenSignal, 250)
    })
}

startListenSignal()

const { SESSION_SECRET_KEY } = process.env

if (!SESSION_SECRET_KEY) {
  console.warn('SESSION_SECRET_KEY is not defined')
}

class Session {
  id: string
  private token: string
  private currentChannel: string | null = null
  private unsubscriptionMap = new Map<string, () => void>()
  connectedToSFU: boolean = false

  constructor(private socket: WebSocket) {
    this.id = v4()
    this.token = createHmac('sha256', SESSION_SECRET_KEY!)
      .update(this.id)
      .digest('hex')

    this.informConnected()
    this.subscribe(prefixer.direct(this.id))
  }

  sendJSON(data: any) {
    this.socket.send(JSON.stringify(data))
  }

  private informConnected() {
    const action = actionCreators.connected(this.id, this.token)
    this.sendJSON(action)
  }

  handle(action: ReceiveAction) {
    switch (action.type) {
      case 'getId': {
        this.handleGetId()
        break
      }
      case 'reuseId': {
        break
      }
      case 'subscribe': {
        this.handleSubscribe(action.key)
        break
      }
      case 'unsubscribe': {
        this.handleUnsubscribe(action.key)
        break
      }
      case 'enter': {
        this.handleEnter(action.channel)
        break
      }
      case 'leave': {
        this.handleLeave()
        break
      }
      case 'message': {
        this.handleMessage(action.message)
        break
      }
      case 'listSessions': {
        this.handleListSessions()
        break
      }
      case 'call': {
        this.handleCall(action)
        break
      }
      case 'answer': {
        this.handleAnswer(action)
        break
      }
      case 'candidate': {
        this.handleCandidate(action)
        break
      }
      case 'integrateUser': {
        this.handleIntegrateUser(action.user)
        break
      }
      // case 'SFUCandidate': {
      //   this.handleSFUCandidate(action.candidate, action.sessionId)
      //   break
      // }
      // case 'SFUAnswer': {
      //   this.handleSFUAnswer(action.sessionId, action.sdp)
      // }
    }
  }

  subscribe(key: string) {
    const unsubscribe = subscription.subscribe(key, this)
    this.unsubscriptionMap.set(key, unsubscribe)
  }

  unsubscribe(key: string) {
    const unsubscribe = this.unsubscriptionMap.get(key)
    unsubscribe?.()
    this.unsubscriptionMap.delete(key)
  }

  private handleGetId() {
    const action = actionCreators.getIdSuccess(this.id)
    this.sendJSON(action)
  }

  private handleSubscribe(key: string) {
    this.subscribe(key)
    const action = actionCreators.subscriptionSuccess(key)
    this.sendJSON(action)
  }

  private handleUnsubscribe(key: string) {
    this.unsubscribe(key)
  }

  private async handleEnter(channelId: string) {
    const channel = await channelService.findById(channelId)
    if (!channel) {
      // TODO: send error
      return
    }

    const user = await sessionService.getUserBySessionId(this.id)
    if (!user) {
      // TODO: send error
      return
    }

    this.subscribe(prefixer.channel(channelId))
    if (channel.sfuServerId) {
      this.connectedToSFU = true
    }
    this.sendJSON(actionCreators.enterSuccess(!!channel.sfuServerId))

    channelHelper.enter(channelId, this.id, user)
    this.currentChannel = channelId
  }

  private handleLeave() {
    if (!this.currentChannel) return
    this.unsubscribe(prefixer.channel(this.currentChannel))

    channelHelper.leave(this.currentChannel, this.id)
    this.currentChannel = null
  }

  private handleMessage(message: Message) {
    if (!this.currentChannel) return
    channelHelper.message(this.currentChannel, this.id, message)
  }

  async handleListSessions() {
    if (!this.currentChannel) return
    try {
      const sessions = await channelService.listUsers(this.currentChannel)
      this.sendJSON(actionCreators.listSessionsSuccess(sessions))
    } catch (e) {
      console.error(e)
    }
  }

  async handleCall(action: CallAction) {
    if (action.isSFU) {
      if (!this.currentChannel) return
      try {
        const result = await grpcClient.call({
          channelId: this.currentChannel,
          sessionId: this.id,
          sdp: action.sdp,
        })

        this.sendJSON(actionCreators.answered(undefined, result, true))
      } catch (e) {
        console.log(e)
      }
    } else {
      rtcHelper.call({
        from: this.id,
        to: action.to,
        sdp: action.sdp,
      })
    }
  }

  handleAnswer(action: AnswerAction) {
    const { isSFU, to, sdp } = action
    if (isSFU) {
      if (!this.currentChannel) return
      grpcClient.answer({
        channelId: this.currentChannel,
        fromSessionId: this.id,
        sdp,
        sessionId: to,
      })
    } else {
      rtcHelper.answer({
        from: this.id,
        to,
        sdp,
      })
    }
  }

  handleCandidate(action: CandidateAction) {
    const { to, isSFU, candidate } = action

    if (isSFU) {
      try {
        // ensures answer first
        setTimeout(() => {
          grpcClient.clientIcecandidate({
            sessionId: to,
            fromSessionId: this.id,
            candidate: JSON.stringify(candidate),
          })
        }, 50)
      } catch (e) {}
    } else {
      rtcHelper.candidate({
        from: this.id,
        to,
        candidate,
      })
    }
  }

  async handleIntegrateUser(user: Record<string, any>) {
    if (!config.allowAnonymous) return
    const userWithSessionId = {
      ...user,
      id: this.id,
    }
    await sessionService.integrate(this.id, JSON.stringify(userWithSessionId))
    this.sendJSON(actionCreators.integrated(userWithSessionId))
  }

  public sendSubscriptionMessage(key: string, message: any) {
    // const action = actionCreators.subscriptionMessage(key, message)
    this.sendJSON(message)
  }

  dispose() {
    const fns = Array.from(this.unsubscriptionMap.values())
    fns.forEach(fn => fn())
    // remove from channel
    if (!this.currentChannel) return
    channelHelper.leave(this.currentChannel, this.id)
    if (this.connectedToSFU) {
      grpcClient.leave({
        sessionId: this.id,
        channelId: this.currentChannel,
      })
    }
  }
}

export default Session
