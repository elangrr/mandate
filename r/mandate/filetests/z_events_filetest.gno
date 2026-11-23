// PKGPATH: gno.land/r/mandate_dev/mandate/filetests/z_events_filetest

// Every state change emits one event. Pulled is emitted by Pull, which only
// a session-signed transaction can reach; scripts/local-flow.sh checks it.
package z_events_filetest

import (
	"testing"
	"time"

	"gno.land/r/mandate_dev/mandate"
)

const (
	payee = address("g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5") // test1
	payer = address("g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj") // test2
	gpub  = "gpub1pgfj7ard9eg82cjtv4u4xetrwqer2dntxyfzxz3pqfp0696ldln2nm7kd33zfpgypg6u0e7upl03hyeexa6mccn4ce8mkswg65c"
	sess  = address("g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh")
)

func main(cur realm) {
	testing.SetRealm(testing.NewUserRealm(payee))
	id := mandate.Offer(cross(cur), "Weekly supporter", 1_000_000, 604800)
	testing.SetRealm(testing.NewUserRealm(payee))
	mandate.SetCollectorKey(cross(cur), gpub)
	testing.SetRealm(testing.NewUserRealm(payer))
	mandate.Subscribe(cross(cur), id, sess, time.Now().Unix()+86400)
	testing.SetRealm(testing.NewUserRealm(payer))
	mandate.Cancel(cross(cur), payer, sess)
	println(mandate.HasMandate(payer, id))
}

// Output:
// false

// Events:
// [
//   {
//     "type": "PlanOffered",
//     "attrs": [
//       {
//         "key": "plan",
//         "value": "1"
//       },
//       {
//         "key": "payee",
//         "value": "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5"
//       },
//       {
//         "key": "amount",
//         "value": "1000000"
//       },
//       {
//         "key": "period",
//         "value": "604800"
//       }
//     ],
//     "pkg_path": "gno.land/r/mandate_dev/mandate"
//   },
//   {
//     "type": "CollectorKeySet",
//     "attrs": [
//       {
//         "key": "payee",
//         "value": "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5"
//       },
//       {
//         "key": "key",
//         "value": "g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh"
//       }
//     ],
//     "pkg_path": "gno.land/r/mandate_dev/mandate"
//   },
//   {
//     "type": "Subscribed",
//     "attrs": [
//       {
//         "key": "mandate",
//         "value": "1"
//       },
//       {
//         "key": "plan",
//         "value": "1"
//       },
//       {
//         "key": "payer",
//         "value": "g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj"
//       },
//       {
//         "key": "payee",
//         "value": "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5"
//       },
//       {
//         "key": "session",
//         "value": "g1psdsf789f4xw3qrpjue54g2h28syd09yfkrxdh"
//       },
//       {
//         "key": "expires",
//         "value": "1234654290"
//       },
//       {
//         "key": "first",
//         "value": "1234567890"
//       }
//     ],
//     "pkg_path": "gno.land/r/mandate_dev/mandate"
//   },
//   {
//     "type": "Cancelled",
//     "attrs": [
//       {
//         "key": "mandate",
//         "value": "1"
//       },
//       {
//         "key": "plan",
//         "value": "1"
//       },
//       {
//         "key": "payer",
//         "value": "g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj"
//       },
//       {
//         "key": "by",
//         "value": "g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj"
//       }
//     ],
//     "pkg_path": "gno.land/r/mandate_dev/mandate"
//   }
// ]
