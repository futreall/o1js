import {
  Field,
  SmartContract,
  state,
  State,
  method,
  DeployArgs,
  Permissions,
  Bool,
  PublicKey,
  Experimental,
  Circuit,
  Poseidon,
} from 'snarkyjs';
import { Member } from './member';
import { ParticipantPreconditions } from './preconditions';

let participantPreconditions = ParticipantPreconditions.default;

interface MembershipParams {
  participantPreconditions: ParticipantPreconditions;
  contractAddress: PublicKey;
  doProofs: boolean;
}

/**
 * Returns a new contract instance that based on a set of preconditions.
 * @param params {@link MembershipParams}
 */
export async function Membership(
  params: MembershipParams
): Promise<Membership_> {
  participantPreconditions = params.participantPreconditions;

  let contract = new Membership_(params.contractAddress);
  if (params.doProofs) {
    await Membership_.compile(params.contractAddress);
  }

  return contract;
}

/**
 * The Membership contract keeps track of a set of members.
 * The contract can either be of type Voter or Candidate.
 */
export class Membership_ extends SmartContract {
  /**
   * Root of the merkle tree that stores all committed members.
   */
  @state(Field) committedMembers = State<Field>();

  /**
   * Accumulator of all emitted members.
   */
  @state(Field) accumulatedMembers = State<Field>();

  reducer = Experimental.Reducer({ actionType: Member });

  deploy(args: DeployArgs) {
    super.deploy(args);
    this.setPermissions({
      ...Permissions.default(),
      editState: Permissions.proofOrSignature(),
      editSequenceState: Permissions.none(), // TODO: fix permissions
    });
  }

  /**
   * Method used to add a new member.
   * Dispatches a new member sequence event.
   * @param member
   */
  @method addEntry(member: Member): Bool {
    // Emit event that indicates adding this item
    // Preconditions: Restrict who can vote or who can be a candidate

    // since we need to keep this contract "generic", we always assert within a range
    // even tho voters cant have a maximum balance, only candidate
    // but for voter we simply use UInt64.MAXINT() as maximum
    member.balance
      .gte(participantPreconditions.minMina)
      .and(member.balance.lte(participantPreconditions.maxMina)).assertTrue;

    let accumulatedMembers = this.accumulatedMembers.get();
    this.accumulatedMembers.assertEquals(accumulatedMembers);

    // checking if the member already exists within the accumulator
    let { state: exists } = this.reducer.reduce(
      [], // TODO: sequence events
      Bool,
      (state: Bool, _action: Member) => {
        return _action.equals(member).or(state);
      },
      // initial state
      { state: Bool(false), actionsHash: accumulatedMembers }
    );

    /*
    TODO: we cant really branch logic, revisit this section later to align with testing docs
    we will always have to emit an event no matter what, 
    so we emit an empty event if the member already exists
    it the member doesnt exist, emit the "real" member
    */

    let toEmit = Circuit.if(exists, Member.empty(), member);

    this.reducer.dispatch(toEmit);

    return exists;
  }

  /**
   * Method used to check whether a member exists within the committed storage.
   * @param accountId
   * @returns true if member exists
   */
  @method isMember(member: Member): Bool {
    // Verify membership (voter or candidate) with the accountId via merkletree committed to by the sequence events and returns a boolean
    // Preconditions: Item exists in committed storage

    let committedMembers = this.committedMembers.get();
    this.committedMembers.assertEquals(committedMembers);

    return member.witness
      .calculateRoot(Poseidon.hash(member.toFields()))
      .equals(committedMembers);
  }

  /**
   * Method used to commit to the accumulated list of members.
   */
  @method publish() {
    // Commit to the items accumulated so far. This is a periodic update

    let accumulatedMembers = this.accumulatedMembers.get();
    this.accumulatedMembers.assertEquals(accumulatedMembers);

    let committedMembers = this.committedMembers.get();
    this.committedMembers.assertEquals(committedMembers);

    let { state: newCommittedMembers, actionsHash: newAccumulatedMembers } =
      this.reducer.reduce(
        [], // TODO: sequence events
        Field,
        (state: Field, _action: Member) => {
          // because we inserted empty members, we need to check if a member is empty or "real"
          let isRealMember = Circuit.if(
            _action.publicKey.equals(PublicKey.empty()),
            Bool(false),
            Bool(true)
          );

          // if the member is real and not empty, we calculate and return the new merkle root
          // otherwise, we simply return the unmodified state
          return Circuit.if(
            isRealMember,
            _action.witness.calculateRoot(Poseidon.hash(_action.toFields())),
            state
          );
        },
        // initial state
        { state: committedMembers, actionsHash: accumulatedMembers }
      );

    this.committedMembers.set(newCommittedMembers);
    this.accumulatedMembers.set(newAccumulatedMembers);
  }
}
