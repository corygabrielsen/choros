import { describe, expect, test } from 'bun:test'
import {
  chorosEventToResponsesItem,
  chorosEventToSteerInput,
  formatChorosEvent,
} from '#choros/codex/events.ts'

describe('codex event formatting', () => {
  test('formats inbound messages as model-visible user text', () => {
    const params = {
      from_name: 'alice',
      from_session: 'aaaaaaaa-0000-0000-0000-000000000001',
      msg_id: 'm1',
      act: 'QUESTION',
      body: 'Can you check CI?',
    }
    expect(formatChorosEvent('choros.inbound_message', params)).toBe(
      '[choros:inbound_message from_name=alice from_session=aaaaaaaa-0000-0000-0000-000000000001 msg_id=m1 act=QUESTION]\nCan you check CI?',
    )
    expect(chorosEventToResponsesItem('choros.inbound_message', params)).toEqual({
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: '[choros:inbound_message from_name=alice from_session=aaaaaaaa-0000-0000-0000-000000000001 msg_id=m1 act=QUESTION]\nCan you check CI?',
        },
      ],
    })
  })

  test('steer input includes Codex-required text_elements', () => {
    expect(chorosEventToSteerInput('choros.ack', { msg_id: 'm1', status: 'delivered' })).toEqual({
      type: 'text',
      text: '[choros:ack msg_id=m1 status=delivered]',
      text_elements: [],
    })
  })
})
